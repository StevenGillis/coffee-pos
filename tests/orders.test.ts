// Covers PRD acceptance criteria at the logic level (AC1–AC8).
// Runs twice: on embedded PGlite (local dev) and through the real Postgres
// wire protocol with postgres.js (what Vercel + Neon use).
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import {
  applyOrderAction,
  getOrder,
  handleUberWebhook,
  listOrders,
  normaliseUberOrder,
} from "@/lib/orders";
import { saveMockUberOrder, signUberBody, verifyUberSignature } from "@/lib/uber";

const SECRET = "test-secret";

process.env.UBER_MODE = "mock";
process.env.UBER_CLIENT_SECRET = SECRET;
process.env.PREP_MINUTES = "10";

const sampleOrder = (id: string) => ({
  id,
  display_id: "BC953",
  current_state: "CREATED",
  type: "DELIVERY_BY_UBER",
  eater: { first_name: "Larry" },
  cart: {
    special_instructions: "Ring the bell",
    items: [
      {
        id: "Latte",
        title: "Latte",
        quantity: 2,
        special_instructions: "make it iced please",
        selected_modifier_groups: [
          { id: "milk", title: "Milk", selected_items: [{ id: "oat", title: "Oat", quantity: 1 }], removed_items: null },
          { id: "sugar", title: "Add sugar", selected_items: null, removed_items: [{ id: "Sugar", title: "Sugar", quantity: 0 }] },
        ],
      },
    ],
  },
  placed_at: "2026-11-13T10:00:00Z",
  estimated_ready_for_pickup_at: "2026-11-13T10:10:00Z",
});

async function seedMockOrder(id: string) {
  // Same code path the simulator's /api/dev/mock-order route uses.
  await saveMockUberOrder(JSON.stringify(sampleOrder(id)));
}

function webhook(orderId: string, type = "orders.notification", eventId = crypto.randomUUID()) {
  const body = JSON.stringify({ event_type: type, event_id: eventId, meta: { resource_id: orderId } });
  return { body, sig: signUberBody(body, SECRET) };
}

async function deliver(orderId: string, type?: string, eventId?: string) {
  const { body, sig } = webhook(orderId, type, eventId);
  const res = await handleUberWebhook(body, sig);
  await res.followUp?.();
  return res;
}

describe("webhook signature", () => {
  it("accepts Uber's lowercase hex HMAC-SHA256 of the raw body", () => {
    const body = '{"a":1}';
    expect(verifyUberSignature(body, signUberBody(body, SECRET), SECRET)).toBe(true);
  });
  it("rejects wrong, missing or malformed signatures", () => {
    const body = '{"a":1}';
    expect(verifyUberSignature(body, signUberBody(body, "other"), SECRET)).toBe(false);
    expect(verifyUberSignature(body, null, SECRET)).toBe(false);
    expect(verifyUberSignature(body, "zz", SECRET)).toBe(false);
    expect(verifyUberSignature(body + " ", signUberBody(body, SECRET), SECRET)).toBe(false);
  });
});

describe("Uber order normalising (AC8)", () => {
  it("keeps every option, removal and note", () => {
    const o = normaliseUberOrder(sampleOrder("x"));
    expect(o.customerName).toBe("Larry");
    expect(o.specialInstructions).toBe("Ring the bell");
    expect(o.items).toEqual([
      { title: "Latte", quantity: 2, options: ["Milk: Oat", "No Sugar"], note: "make it iced please" },
    ]);
  });
});

describe.each(["pglite", "postgres"] as const)("on %s", (backend) => {
  let server: PGLiteSocketServer | undefined;
  let socketDb: PGlite | undefined;

  beforeAll(async () => {
    resetDbForTests();
    if (backend === "postgres") {
      socketDb = await PGlite.create();
      server = new PGLiteSocketServer({ db: socketDb, port: 54329, host: "127.0.0.1" });
      await server.start();
      process.env.DATABASE_URL = "postgres://postgres@127.0.0.1:54329/postgres";
    } else {
      process.env.DATABASE_URL = "memory://";
    }
  });

  afterAll(async () => {
    resetDbForTests();
    await server?.stop();
    await socketDb?.close();
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.query("TRUNCATE uber_events, orders, mock_uber_orders, app_state, login_failures");
  });

  describe("receiving orders", () => {
    it("AC1: a signed notification creates an order with full details", async () => {
      await seedMockOrder("order-1");
      const res = await deliver("order-1");
      expect(res.status).toBe(200);
      const order = await getOrder("order-1");
      expect(order).toMatchObject({ status: "new", displayId: "BC953", customerName: "Larry", detailsLoaded: true });
      expect(order?.items[0].options).toContain("Milk: Oat");
    });

    it("stores JSON as structured data, not as one long string", async () => {
      await seedMockOrder("order-json");
      await deliver("order-json");
      const db = await getDb();
      const [mock] = await db.query<{ kind: string }>(
        "SELECT jsonb_typeof(payload) AS kind FROM mock_uber_orders WHERE id = 'order-json'",
      );
      const [order] = await db.query<{ kind: string }>(
        "SELECT jsonb_typeof(items) AS kind FROM orders WHERE id = 'order-json'",
      );
      expect(mock.kind).toBe("object");
      expect(order.kind).toBe("array");
    });

    it("AC2: an invalid signature is rejected and stores nothing", async () => {
      const { body } = webhook("order-2");
      const res = await handleUberWebhook(body, signUberBody(body, "attacker"));
      expect(res.status).toBe(401);
      expect(await getOrder("order-2")).toBeNull();
    });

    it("AC3: the same event delivered twice creates one order", async () => {
      await seedMockOrder("order-3");
      const eventId = crypto.randomUUID();
      await deliver("order-3", "orders.notification", eventId);
      await deliver("order-3", "orders.notification", eventId);
      const orders = await listOrders();
      expect(orders.filter((o) => o.id === "order-3")).toHaveLength(1);
    });

    it("shows the order even if details can't be fetched yet", async () => {
      await deliver("order-unknown");
      expect(await getOrder("order-unknown")).toMatchObject({ status: "new", detailsLoaded: false });
    });

    it("AC7: an Uber cancellation removes the order from the active queue", async () => {
      await seedMockOrder("order-7");
      await deliver("order-7");
      await applyOrderAction("order-7", { type: "accept" });
      await deliver("order-7", "orders.cancel");
      expect((await getOrder("order-7"))?.status).toBe("cancelled");
    });
  });

  describe("barista actions", () => {
    it("AC4 + AC6: accept → start → ready → picked up", async () => {
      await seedMockOrder("order-4");
      await deliver("order-4");
      expect((await applyOrderAction("order-4", { type: "accept" })).status).toBe("accepted");
      expect((await applyOrderAction("order-4", { type: "start" })).status).toBe("preparing");
      expect((await applyOrderAction("order-4", { type: "ready" })).status).toBe("ready");
      expect((await applyOrderAction("order-4", { type: "pickup" })).status).toBe("picked_up");
    });

    it("AC5: reject stores the reason", async () => {
      await seedMockOrder("order-5");
      await deliver("order-5");
      const o = await applyOrderAction("order-5", { type: "reject", reason: "CAPACITY" });
      expect(o).toMatchObject({ status: "rejected", rejectReason: "CAPACITY" });
    });

    it("refuses invalid transitions", async () => {
      await seedMockOrder("order-6");
      await deliver("order-6");
      await expect(applyOrderAction("order-6", { type: "pickup" })).rejects.toMatchObject({ status: 409 });
      await applyOrderAction("order-6", { type: "accept" });
      await expect(applyOrderAction("order-6", { type: "accept" })).rejects.toMatchObject({ status: 409 });
    });

    it("expires orders not accepted within 11.5 minutes", async () => {
      await seedMockOrder("order-8");
      await deliver("order-8");
      const db = await getDb();
      await db.query("UPDATE orders SET received_at = now() - interval '12 minutes' WHERE id = 'order-8'");
      const orders = await listOrders();
      expect(orders.find((o) => o.id === "order-8")?.status).toBe("expired");
      await expect(applyOrderAction("order-8", { type: "accept" })).rejects.toMatchObject({ status: 409 });
    });
  });
});
