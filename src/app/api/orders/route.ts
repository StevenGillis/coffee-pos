import type { NextRequest } from "next/server";
import { after } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { listOrders, retryMissingDetails } from "@/lib/orders";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) return unauthorized();
  const orders = await listOrders();
  if (orders.some((o) => !o.detailsLoaded && o.status === "new")) after(() => retryMissingDetails());
  return Response.json({ orders, serverTime: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
