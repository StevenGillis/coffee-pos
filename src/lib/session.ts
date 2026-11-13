// Signed login cookie for the shared store passcode.
// Uses Web Crypto so it works in proxy.ts and in route handlers.

export const SESSION_COOKIE = "barista_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, nowMs = Date.now()): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expires}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires * 1000 < nowMs) return false;
  const expected = await hmacHex(secret, `${parts[0]}.${parts[1]}`);
  return constantTimeEqual(expected, parts[2]);
}

export function passcodeMatches(given: string, expected: string): boolean {
  return constantTimeEqual(given.padEnd(64), expected.padEnd(64)) && given.length === expected.length;
}
