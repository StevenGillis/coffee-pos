// AC9: the board is only reachable with a valid, unexpired, untampered session.
import { describe, expect, it } from "vitest";
import { createSessionToken, passcodeMatches, SESSION_TTL_SECONDS, verifySessionToken } from "@/lib/session";

describe("session cookie", () => {
  it("accepts a fresh token", async () => {
    const token = await createSessionToken("s3cret");
    expect(await verifySessionToken(token, "s3cret")).toBe(true);
  });
  it("rejects missing, tampered, wrong-key and expired tokens", async () => {
    const token = await createSessionToken("s3cret");
    const [v, exp, sig] = token.split(".");
    expect(await verifySessionToken(undefined, "s3cret")).toBe(false);
    expect(await verifySessionToken(`${v}.${Number(exp) + 9999}.${sig}`, "s3cret")).toBe(false);
    expect(await verifySessionToken(token, "other")).toBe(false);
    const later = Date.now() + (SESSION_TTL_SECONDS + 60) * 1000;
    expect(await verifySessionToken(token, "s3cret", later)).toBe(false);
  });
  it("matches passcodes exactly", () => {
    expect(passcodeMatches("123456", "123456")).toBe(true);
    expect(passcodeMatches("12345", "123456")).toBe(false);
    expect(passcodeMatches("1234567", "123456")).toBe(false);
    expect(passcodeMatches("", "123456")).toBe(false);
  });
});
