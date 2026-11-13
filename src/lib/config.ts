// Central place for reading environment configuration.

export type UberMode = "mock" | "sandbox" | "production";

export function uberMode(): UberMode {
  const mode = (process.env.UBER_MODE ?? "mock").toLowerCase();
  if (mode === "mock" || mode === "sandbox" || mode === "production") return mode;
  throw new Error(`UBER_MODE must be mock, sandbox or production (got "${mode}")`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

export const config = {
  uberClientSecret: () => required("UBER_CLIENT_SECRET"),
  uberClientId: () => required("UBER_CLIENT_ID"),
  storePasscode: () => required("STORE_PASSCODE"),
  sessionSecret: () => required("SESSION_SECRET"),
  prepMinutes: () => Number(process.env.PREP_MINUTES ?? 10) || 10,
  databaseUrl: () => process.env.DATABASE_URL ?? "",
};

/** Uber auto-cancels orders not accepted/denied within 11.5 minutes. */
export const ACCEPT_WINDOW_MS = 11.5 * 60 * 1000;
