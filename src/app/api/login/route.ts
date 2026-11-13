import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { createSessionToken, passcodeMatches, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/session";

const MAX_FAILURES = 10; // per IP per 15 minutes

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const db = await getDb();
  const [{ count }] = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM login_failures WHERE ip = $1 AND at > now() - interval '15 minutes'",
    [ip],
  );
  if (count >= MAX_FAILURES) {
    return Response.json({ error: "Too many attempts. Wait 15 minutes." }, { status: 429 });
  }

  const { passcode } = ((await req.json().catch(() => ({}))) ?? {}) as { passcode?: string };
  if (typeof passcode !== "string" || !passcodeMatches(passcode, config.storePasscode())) {
    await db.query("INSERT INTO login_failures (ip) VALUES ($1)", [ip]);
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: "Wrong passcode" }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  const token = await createSessionToken(config.sessionSecret());
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
  return res;
}
