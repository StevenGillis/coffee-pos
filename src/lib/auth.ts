import type { NextRequest } from "next/server";
import { config } from "./config";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/** Real auth check for API routes (proxy.ts only does an early redirect). */
export async function isAuthenticated(req: NextRequest): Promise<boolean> {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret());
}

export const unauthorized = () => Response.json({ error: "Please sign in" }, { status: 401 });
