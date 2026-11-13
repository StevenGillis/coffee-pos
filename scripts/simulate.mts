// Send fake, correctly-signed Uber Eats webhooks to the local app.
//
//   npm run simulate                 → one new random coffee order
//   npm run simulate -- 3            → three new orders
//   npm run simulate -- cancel <id>  → Uber cancels an order (use the full id or #display id)
//   npm run simulate -- duplicate    → same webhook sent twice (should create one order)
//
// Only works while UBER_MODE=mock. Target URL: APP_URL (default http://localhost:3000).
import { createHmac, randomUUID } from "node:crypto";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may come from the shell instead */
}

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SECRET = process.env.UBER_CLIENT_SECRET;
if (!SECRET) throw new Error("UBER_CLIENT_SECRET is not set (.env.local)");
if ((process.env.UBER_MODE ?? "mock") !== "mock") {
  throw new Error("The simulator only runs with UBER_MODE=mock. Use the Uber sandbox for real test orders.");
}

const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

async function post(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(APP_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Uber-Signature": sign(body), "X-Environment": "sandbox" },
    body,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
}

const NAMES = ["Maya", "Leo", "Priya", "Sam", "Ines", "Kenji", "Ana", "Omar", "Zoe", "Theo"];
const DRINKS = [
  { title: "Flat White", sizes: true, milk: true },
  { title: "Oat Latte", sizes: true, milk: false },
  { title: "Cortado", sizes: false, milk: true },
  { title: "Cold Brew", sizes: true, milk: false },
  { title: "Cappuccino", sizes: true, milk: true },
  { title: "Matcha Latte", sizes: true, milk: true },
  { title: "Butter Croissant", sizes: false, milk: false },
  { title: "Banana Bread", sizes: false, milk: false },
];
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

function randomUberOrder(id: string) {
  const items = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => {
    const d = pick(DRINKS);
    const groups = [];
    if (d.sizes) groups.push({ id: "size", title: "Size", selected_items: [{ id: "s", title: pick(["Small", "Medium", "Large"]), quantity: 1 }] });
    if (d.milk) groups.push({ id: "milk", title: "Milk", selected_items: [{ id: "m", title: pick(["Whole", "Oat", "Almond", "Skim"]), quantity: 1 }] });
    if (d.sizes && Math.random() < 0.3) groups.push({ id: "extra", title: "Extras", selected_items: [{ id: "x", title: "Extra shot", quantity: 1 }] });
    if (d.title === "Cappuccino" && Math.random() < 0.3) groups.push({ id: "sugar", title: "Sugar", selected_items: null, removed_items: [{ id: "sugar", title: "Sugar", quantity: 0 }] });
    return {
      id: d.title.replace(/\s/g, "-"),
      instance_id: randomUUID(),
      title: d.title,
      quantity: Math.random() < 0.2 ? 2 : 1,
      selected_modifier_groups: groups,
      ...(Math.random() < 0.2 ? { special_instructions: pick(["extra hot please", "light ice", "no lid"]) } : {}),
    };
  });
  const placed = new Date();
  return {
    id,
    display_id: id.slice(-5).toUpperCase(),
    current_state: "CREATED",
    type: pick(["DELIVERY_BY_UBER", "PICK_UP"]),
    eater: { first_name: pick(NAMES) },
    cart: { items, ...(Math.random() < 0.15 ? { special_instructions: "Please write a smiley on the cup 🙂" } : {}) },
    placed_at: placed.toISOString(),
    estimated_ready_for_pickup_at: new Date(placed.getTime() + 10 * 60_000).toISOString(),
  };
}

function notification(orderId: string, type = "orders.notification") {
  return {
    event_type: type,
    event_id: randomUUID(),
    event_time: Math.floor(Date.now() / 1000),
    meta: { resource_id: orderId, status: "pos", user_id: "test-store" },
    resource_href: `https://test-api.uber.com/v2/eats/order/${orderId}`,
  };
}

async function newOrder(): Promise<string> {
  const id = randomUUID();
  const order = randomUberOrder(id);
  await post("/api/dev/mock-order", order);
  await post("/api/webhooks/uber", notification(id));
  console.log(`☕ New order #${order.display_id} for ${order.eater.first_name}: ${order.cart.items.map((i) => `${i.quantity}× ${i.title}`).join(", ")}`);
  console.log(`   id: ${id}`);
  return id;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "cancel") {
  if (!arg) throw new Error("Usage: npm run simulate -- cancel <order id>");
  await post("/api/webhooks/uber", notification(arg, "orders.cancel"));
  console.log(`✖ Uber cancelled order ${arg}`);
} else if (cmd === "duplicate") {
  const id = randomUUID();
  await post("/api/dev/mock-order", randomUberOrder(id));
  const event = notification(id);
  await post("/api/webhooks/uber", event);
  await post("/api/webhooks/uber", event);
  console.log(`↻ Sent the same webhook twice for ${id} — the board should show it once.`);
} else {
  const count = Math.max(1, Number(cmd) || 1);
  for (let i = 0; i < count; i++) await newOrder();
}
