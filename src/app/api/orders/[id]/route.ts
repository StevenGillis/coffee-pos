import type { NextRequest } from "next/server";
import { isAuthenticated, unauthorized } from "@/lib/auth";
import { ActionError, applyOrderAction, type OrderAction } from "@/lib/orders";
import { DENY_REASONS, UberApiError, type DenyReason } from "@/lib/uber";

function parseAction(body: unknown): OrderAction | null {
  const b = (body ?? {}) as { type?: string; reason?: string; explanation?: string };
  switch (b.type) {
    case "accept":
    case "start":
    case "ready":
    case "pickup":
      return { type: b.type };
    case "reject":
      if (!DENY_REASONS.includes(b.reason as DenyReason)) return null;
      return { type: "reject", reason: b.reason as DenyReason, explanation: b.explanation?.slice(0, 200) };
    default:
      return null;
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/orders/[id]">) {
  if (!(await isAuthenticated(req))) return unauthorized();
  const { id } = await ctx.params;
  const action = parseAction(await req.json().catch(() => null));
  if (!action) return Response.json({ error: "Unknown action" }, { status: 400 });

  try {
    const order = await applyOrderAction(id, action);
    return Response.json({ order });
  } catch (err) {
    if (err instanceof ActionError) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof UberApiError) {
      console.error(err);
      return Response.json({ error: "Uber didn't accept the update. Try again." }, { status: 502 });
    }
    throw err;
  }
}
