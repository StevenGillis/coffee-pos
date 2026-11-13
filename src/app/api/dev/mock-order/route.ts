// MOCK MODE ONLY: lets the simulator register a fake Uber order so the
// webhook's "fetch order details" step can find it. Signed like Uber webhooks.
import { config, uberMode } from "@/lib/config";
import { getDb } from "@/lib/db";
import { verifyUberSignature } from "@/lib/uber";

export async function POST(req: Request) {
  if (uberMode() !== "mock") return new Response(null, { status: 404 });
  const raw = await req.text();
  if (!verifyUberSignature(raw, req.headers.get("x-uber-signature"), config.uberClientSecret())) {
    return new Response(null, { status: 401 });
  }
  const order = JSON.parse(raw) as { id?: string };
  if (!order.id) return Response.json({ error: "id required" }, { status: 400 });
  const db = await getDb();
  await db.query(
    "INSERT INTO mock_uber_orders (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload",
    [order.id, raw],
  );
  return Response.json({ ok: true });
}
