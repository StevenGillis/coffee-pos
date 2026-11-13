// Uber Eats Marketplace API client.
// Endpoint paths follow Uber's Order API reference; see docs/DESIGN.md for the
// open question about newer /v1/delivery/... paths. Change them here only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, uberMode } from "./config";
import { getDb } from "./db";

const HOSTS = {
  sandbox: { auth: "https://sandbox-login.uber.com", api: "https://test-api.uber.com" },
  production: { auth: "https://auth.uber.com", api: "https://api.uber.com" },
} as const;

const PATHS = {
  token: "/oauth/v2/token",
  orderDetails: (id: string) => `/v2/eats/order/${encodeURIComponent(id)}`,
  accept: (id: string) => `/v1/eats/orders/${encodeURIComponent(id)}/accept_pos_order`,
  deny: (id: string) => `/v1/eats/orders/${encodeURIComponent(id)}/deny_pos_order`,
};

export const DENY_REASONS = [
  "STORE_CLOSED",
  "CAPACITY",
  "ITEM_AVAILABILITY",
  "MISSING_ITEM",
  "SPECIAL_INSTRUCTIONS",
  "OTHER",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** Verify Uber's X-Uber-Signature: lowercase hex HMAC-SHA256 of the raw body keyed with the client secret. */
export function verifyUberSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signUberBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export class UberApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function hosts() {
  const mode = uberMode();
  if (mode === "mock") throw new Error("No Uber hosts in mock mode");
  return HOSTS[mode];
}

/** Client-credentials token, cached in the database (Uber allows only 100 new tokens per hour). */
async function getAccessToken(): Promise<string> {
  const db = await getDb();
  const cacheKey = `uber_token_${uberMode()}`;
  const [cached] = await db.query<{ value: string }>(
    "SELECT value FROM app_state WHERE key = $1 AND expires_at > now() + interval '1 hour'",
    [cacheKey],
  );
  if (cached) return cached.value;

  const body = new URLSearchParams({
    client_id: config.uberClientId(),
    client_secret: config.uberClientSecret(),
    grant_type: "client_credentials",
    scope: "eats.order",
  });
  const res = await fetch(hosts().auth + PATHS.token, { method: "POST", body });
  if (!res.ok) throw new UberApiError(`Uber token request failed (${res.status})`, res.status);
  const json = (await res.json()) as { access_token: string; expires_in: number };

  await db.query(
    `INSERT INTO app_state (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [cacheKey, json.access_token, json.expires_in],
  );
  return json.access_token;
}

async function uberFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(hosts().api + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UberApiError(`Uber API ${res.status} on ${path}: ${text.slice(0, 200)}`, res.status);
  }
  return res;
}

/** Raw Uber order details JSON (shape documented in Uber's Get Order Details reference). */
export type UberOrder = Record<string, unknown>;

export async function fetchOrderDetails(orderId: string): Promise<UberOrder | null> {
  if (uberMode() === "mock") {
    const db = await getDb();
    const [row] = await db.query<{ payload: UberOrder }>(
      "SELECT payload FROM mock_uber_orders WHERE id = $1",
      [orderId],
    );
    return row?.payload ?? null;
  }
  const res = await uberFetch(PATHS.orderDetails(orderId));
  return (await res.json()) as UberOrder;
}

export async function acceptOrder(orderId: string, pickupTime: Date): Promise<void> {
  const body = {
    reason: "Accepted on barista screen",
    pickup_time: Math.floor(pickupTime.getTime() / 1000),
  };
  if (uberMode() === "mock") {
    console.info(`[mock uber] accept ${orderId}`, body);
    return;
  }
  await uberFetch(PATHS.accept(orderId), { method: "POST", body: JSON.stringify(body) });
}

export async function denyOrder(orderId: string, code: DenyReason, explanation: string): Promise<void> {
  const body = { reason: { code, explanation } };
  if (uberMode() === "mock") {
    console.info(`[mock uber] deny ${orderId}`, body);
    return;
  }
  await uberFetch(PATHS.deny(orderId), { method: "POST", body: JSON.stringify(body) });
}
