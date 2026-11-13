// Tiny database layer: the same SQL runs on embedded PGlite (local dev/tests)
// and on hosted Postgres (production, via DATABASE_URL).
import { config } from "./config";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uber_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  order_id     TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  display_id            TEXT,
  status                TEXT NOT NULL DEFAULT 'new',
  customer_name         TEXT,
  order_type            TEXT,
  items                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  special_instructions  TEXT,
  placed_at             TIMESTAMPTZ,
  ready_by              TIMESTAMPTZ,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  ready_at              TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  reject_reason         TEXT,
  details_loaded        BOOLEAN NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_received_at_idx ON orders (received_at);

CREATE TABLE IF NOT EXISTS app_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS login_failures (
  ip  TEXT NOT NULL,
  at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_failures_ip_idx ON login_failures (ip, at);

CREATE TABLE IF NOT EXISTS mock_uber_orders (
  id       TEXT PRIMARY KEY,
  payload  JSONB NOT NULL
);
`;

async function createDb(): Promise<Db> {
  const url = config.databaseUrl();

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 5, prepare: false });
    return {
      async query<T>(text: string, params: unknown[] = []) {
        return (await sql.unsafe(text, params as never[])) as unknown as T[];
      },
    };
  }

  if (process.env.VERCEL && !url) {
    throw new Error("DATABASE_URL must be set to a hosted Postgres database on Vercel.");
  }

  // Embedded Postgres: in-memory for tests ("memory://"), otherwise stored in
  // ~/.coffee-pos (outside the project, so the dev server's file watcher
  // doesn't reload the page every time the database writes).
  const { PGlite } = await import("@electric-sql/pglite");
  let dataDir: string | undefined;
  if (url !== "memory://") {
    const { mkdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    dataDir = process.env.LOCAL_DB_DIR || join(homedir(), ".coffee-pos", "pglite");
    mkdirSync(dataDir, { recursive: true });
  }
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
}

const globalForDb = globalThis as unknown as { __coffeeDb?: Promise<Db> };

/** Shared, lazily-initialised database with the schema applied. */
export function getDb(): Promise<Db> {
  if (!globalForDb.__coffeeDb) {
    globalForDb.__coffeeDb = (async () => {
      const db = await createDb();
      for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
        await db.query(statement);
      }
      return db;
    })().catch((err) => {
      globalForDb.__coffeeDb = undefined;
      throw err;
    });
  }
  return globalForDb.__coffeeDb;
}

/** Test helper: forget the shared instance so the next getDb() starts fresh. */
export function resetDbForTests() {
  globalForDb.__coffeeDb = undefined;
}
