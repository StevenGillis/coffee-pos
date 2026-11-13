// MOCK MODE ONLY: lets the simulator register a fake Uber order so the
// webhook's "fetch order details" step can find it. Signed like Uber webhooks.
import { config, uberMode } from "@/lib/config";
import { saveMockUberOrder, verifyUberSignature } from "@/lib/uber";

export async function POST(req: Request) {
  if (uberMode() !== "mock") return new Response(null, { status: 404 });
  const raw = await req.text();
  if (!verifyUberSignature(raw, req.headers.get("x-uber-signature"), config.uberClientSecret())) {
    return new Response(null, { status: 401 });
  }
  const id = await saveMockUberOrder(raw).catch(() => null);
  if (!id) return Response.json({ error: "Valid JSON with an id is required" }, { status: 400 });
  return Response.json({ ok: true });
}
