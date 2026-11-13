// Uber Eats webhook: verify signature, store the event, reply 200 fast,
// then fetch order details after the response has been sent.
import { after } from "next/server";
import { handleUberWebhook } from "@/lib/orders";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const result = await handleUberWebhook(rawBody, req.headers.get("x-uber-signature"));
  if (result.followUp) after(result.followUp);
  return new Response(null, { status: result.status });
}
