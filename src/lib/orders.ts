// Order storage, Uber webhook handling, and barista status changes.
import { ACCEPT_WINDOW_MS, config } from "./config";
import { getDb } from "./db";
import {
  acceptOrder,
  denyOrder,
  fetchOrderDetails,
  verifyUberSignature,
  type DenyReason,
  type UberOrder,
} from "./uber";

export type OrderStatus =
  | "new"
  | "accepted"
  | "preparing"
  | "ready"
  | "picked_up"
  | "rejected"
  | "cancelled"
  | "expired";

export interface OrderItem {
  title: string;
  quantity: number;
  options: string[];
  note?: string;
}

export interface Order {
  id: string;
  displayId: string;
  status: OrderStatus;
  customerName: string | null;
  orderType: string | null;
  items: OrderItem[];
  specialInstructions: string | null;
  placedAt: string | null;
  readyBy: string | null;
  receivedAt: string;
  acceptDeadline: string;
  acceptedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  rejectReason: string | null;
  detailsLoaded: boolean;
}

// ---------------------------------------------------------------- normalising

type Json = Record<string, unknown>;
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Turn Uber's cart item modifiers into short human-readable lines, e.g. "Milk: Oat", "No Sugar". */
function describeModifiers(item: Json): string[] {
  const lines: string[] = [];
  for (const group of asArray(item.selected_modifier_groups)) {
    const groupTitle = asString(group.title);
    const selected = asArray(group.selected_items).map((s) => {
      const qty = Number(s.quantity ?? 1);
      const title = asString(s.title) ?? asString(s.id) ?? "?";
      const nested = describeModifiers(s);
      const base = qty > 1 ? `${qty}× ${title}` : title;
      return nested.length ? `${base} (${nested.join(", ")})` : base;
    });
    if (selected.length) lines.push(groupTitle ? `${groupTitle}: ${selected.join(", ")}` : selected.join(", "));
    for (const removed of asArray(group.removed_items)) {
      lines.push(`No ${asString(removed.title) ?? asString(removed.id) ?? "?"}`);
    }
  }
  return lines;
}

export function normaliseUberOrder(raw: UberOrder) {
  const cart = (raw.cart ?? {}) as Json;
  const eater = (raw.eater ?? {}) as Json;
  const items: OrderItem[] = asArray(cart.items).map((item) => {
    const notes = [asString(item.special_instructions), asString(item.special_requests)].filter(Boolean);
    return {
      title: asString(item.title) ?? asString(item.id) ?? "Item",
      quantity: Number(item.quantity ?? 1),
      options: describeModifiers(item),
      ...(notes.length ? { note: notes.join(" · ") } : {}),
    };
  });
  return {
    displayId: asString(raw.display_id) ?? null,
    customerName: asString(eater.first_name) ?? null,
    orderType: asString(raw.type) ?? null,
    items,
    specialInstructions: asString(cart.special_instructions) ?? null,
    placedAt: asString(raw.placed_at) ?? null,
    readyBy: asString(raw.estimated_ready_for_pickup_at) ?? null,
    uberState: asString(raw.current_state) ?? null,
  };
}

// ---------------------------------------------------------------- storage

interface OrderRow {
  id: string;
  display_id: string | null;
  status: OrderStatus;
  customer_name: string | null;
  order_type: string | null;
  items: OrderItem[] | string;
  special_instructions: string | null;
  placed_at: Date | string | null;
  ready_by: Date | string | null;
  received_at: Date | string;
  accepted_at: Date | string | null;
  ready_at: Date | string | null;
  completed_at: Date | string | null;
  reject_reason: string | null;
  details_loaded: boolean;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

function toOrder(row: OrderRow): Order {
  const receivedAt = new Date(row.received_at);
  return {
    id: row.id,
    displayId: row.display_id ?? row.id.slice(-5).toUpperCase(),
    status: row.status,
    customerName: row.customer_name,
    orderType: row.order_type,
    items: typeof row.items === "string" ? JSON.parse(row.items) : row.items,
    specialInstructions: row.special_instructions,
    placedAt: iso(row.placed_at),
    readyBy: iso(row.ready_by),
    receivedAt: receivedAt.toISOString(),
    acceptDeadline: new Date(receivedAt.getTime() + ACCEPT_WINDOW_MS).toISOString(),
    acceptedAt: iso(row.accepted_at),
    readyAt: iso(row.ready_at),
    completedAt: iso(row.completed_at),
    rejectReason: row.reject_reason,
    detailsLoaded: row.details_loaded,
  };
}

export async function getOrder(id: string): Promise<Order | null> {
  const db = await getDb();
  const [row] = await db.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]);
  return row ? toOrder(row) : null;
}

/** Active orders plus anything finished in the last 18 hours (the client shows "today"). */
export async function listOrders(): Promise<Order[]> {
  const db = await getDb();
  // Orders Uber will already have auto-cancelled.
  await db.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
     WHERE status = 'new' AND received_at < now() - make_interval(secs => $1)`,
    [ACCEPT_WINDOW_MS / 1000],
  );
  const rows = await db.query<OrderRow>(
    `SELECT * FROM orders
     WHERE status IN ('new','accepted','preparing','ready') OR received_at > now() - interval '18 hours'
     ORDER BY received_at ASC`,
  );
  return rows.map(toOrder);
}

/** Fetch full order details from Uber and store them. Safe to call repeatedly. */
export async function loadOrderDetails(orderId: string): Promise<boolean> {
  const raw = await fetchOrderDetails(orderId);
  if (!raw) return false;
  const o = normaliseUberOrder(raw);
  const db = await getDb();
  await db.query(
    `UPDATE orders SET display_id = $2, customer_name = $3, order_type = $4, items = $5::text::jsonb,
       special_instructions = $6, placed_at = $7, ready_by = $8, details_loaded = true,
       status = CASE WHEN $9 = 'CANCELED' AND status NOT IN ('picked_up') THEN 'cancelled' ELSE status END,
       updated_at = now()
     WHERE id = $1`,
    [orderId, o.displayId, o.customerName, o.orderType, JSON.stringify(o.items),
     o.specialInstructions, o.placedAt, o.readyBy, o.uberState],
  );
  return true;
}

/** Retry detail loading for orders whose first fetch failed (called while the screen polls). */
export async function retryMissingDetails(limit = 3): Promise<void> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE details_loaded = false AND status = 'new'
       AND received_at < now() - interval '3 seconds' ORDER BY received_at LIMIT $1`,
    [limit],
  );
  for (const { id } of rows) {
    await loadOrderDetails(id).catch((err) => console.error(`Retry details for ${id} failed:`, err));
  }
}

/** Privacy: drop customer names after 30 days. */
export async function purgeOldCustomerData(): Promise<void> {
  const db = await getDb();
  await db.query(
    "UPDATE orders SET customer_name = NULL WHERE customer_name IS NOT NULL AND received_at < now() - interval '30 days'",
  );
}

// ---------------------------------------------------------------- webhook

export interface WebhookResult {
  status: number;
  /** Work to run after the 200 has been sent (e.g. fetching order details). */
  followUp?: () => Promise<void>;
}

interface UberEvent {
  event_id?: string;
  event_type?: string;
  meta?: { resource_id?: string };
}

export async function handleUberWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
  if (!verifyUberSignature(rawBody, signature, config.uberClientSecret())) return { status: 401 };

  let event: UberEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400 };
  }
  const eventId = event.event_id;
  const type = event.event_type ?? "unknown";
  const orderId = event.meta?.resource_id;
  if (!eventId) return { status: 400 };

  const db = await getDb();
  const [seen] = await db.query("SELECT 1 FROM uber_events WHERE event_id = $1", [eventId]);
  if (seen) return { status: 200 }; // duplicate delivery

  let followUp: WebhookResult["followUp"];
  if (type === "orders.notification" && orderId) {
    await db.query("INSERT INTO orders (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [orderId]);
    followUp = async () => {
      await loadOrderDetails(orderId).catch((err) => console.error(`Order details for ${orderId} failed:`, err));
      await purgeOldCustomerData();
    };
  } else if ((type === "orders.cancel" || type === "orders.failure") && orderId) {
    await db.query(
      `UPDATE orders SET status = 'cancelled', completed_at = now(), updated_at = now()
       WHERE id = $1 AND status NOT IN ('picked_up','rejected','cancelled')`,
      [orderId],
    );
  }

  // Record last: if anything above failed, Uber's retry will process the event again.
  await db.query(
    "INSERT INTO uber_events (event_id, event_type, order_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [eventId, type, orderId ?? null],
  );
  return { status: 200, followUp };
}

// ---------------------------------------------------------------- barista actions

export type OrderAction =
  | { type: "accept" }
  | { type: "reject"; reason: DenyReason; explanation?: string }
  | { type: "start" }
  | { type: "ready" }
  | { type: "pickup" };

export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TRANSITIONS: Record<OrderAction["type"], { from: OrderStatus[]; to: OrderStatus; stamp?: string }> = {
  accept: { from: ["new"], to: "accepted", stamp: "accepted_at" },
  reject: { from: ["new"], to: "rejected", stamp: "completed_at" },
  start: { from: ["accepted"], to: "preparing" },
  ready: { from: ["accepted", "preparing"], to: "ready", stamp: "ready_at" },
  pickup: { from: ["ready"], to: "picked_up", stamp: "completed_at" },
};

export async function applyOrderAction(orderId: string, action: OrderAction): Promise<Order> {
  const current = await getOrder(orderId);
  if (!current) throw new ActionError("Order not found", 404);
  const rule = TRANSITIONS[action.type];
  if (!rule.from.includes(current.status)) {
    throw new ActionError(`Can't ${action.type} an order that is ${current.status.replace("_", " ")}`, 409);
  }
  if ((action.type === "accept" || action.type === "reject") && Date.now() > Date.parse(current.acceptDeadline)) {
    throw new ActionError("Too late — Uber has already auto-cancelled this order", 409);
  }

  // Tell Uber first; only change our status if Uber agreed.
  if (action.type === "accept") {
    await acceptOrder(orderId, new Date(Date.now() + config.prepMinutes() * 60_000));
  } else if (action.type === "reject") {
    await denyOrder(orderId, action.reason, action.explanation || "Rejected on barista screen");
  }

  const db = await getDb();
  const stamp = rule.stamp ? `, ${rule.stamp} = now()` : "";
  const rows = await db.query<OrderRow>(
    `UPDATE orders SET status = $2${stamp}, updated_at = now(),
       reject_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE reject_reason END
     WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
    [orderId, rule.to, rule.from, action.type === "reject" ? action.reason : null],
  );
  if (!rows[0]) throw new ActionError("Order changed meanwhile — refresh and try again", 409);
  return toOrder(rows[0]);
}
