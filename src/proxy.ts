// Early redirect to /login for people without a valid session cookie.
// API routes re-check the session themselves; this is only the first gate.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const ok = !!secret && (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, secret));
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // Everything except the login page/API, Uber's webhook (signature-checked),
  // the mock-mode dev endpoint (signature-checked), and static files.
  matcher: ["/((?!login|api/login|api/webhooks|api/dev|_next/static|_next/image|favicon.ico).*)"],
};
