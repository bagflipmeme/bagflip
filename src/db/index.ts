/**
 * Thin DB adapter: PostgreSQL in production (DATABASE_URL), embedded PGlite
 * (Postgres compiled to WASM) for local development and tests. Both run the
 * same SQL, constraints, triggers and row locks.
 *
 * NUMERIC and BIGINT values are always returned as strings so that callers
 * convert them to bigint explicitly — no silent float conversion.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Tx {
  tx<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export async function openDb(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): Promise<Db> {
  const db = opts.url ? await openPg(opts.url) : await openPglite(opts.memory ? undefined : opts.dataDir);
  await migrate(db);
  return db;
}

const asText = (v: string) => v;

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const parsers = { [types.NUMERIC]: asText, [types.INT8]: asText };
  const pg = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await pg.waitReady;
  // PGlite is single-connection: serialize work with a promise chain so a
  // transaction never interleaves with a statement from another caller.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  return {
    kind: "pglite",
    query: (sql, params) => serial(async () => ({ rows: (await pg.query(sql, params as never[])).rows as never[] })),
    tx: (fn) =>
      serial(() =>
        pg.transaction(async (t) => fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params as never[])).rows as never[] }) })),
      ),
    exec: (sql) => serial(async () => void (await pg.exec(sql))),
    close: () => pg.close(),
  };
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(1700, asText); // NUMERIC
  pg.types.setTypeParser(20, asText); // INT8
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: "postgres",
    query: async (sql, params) => ({ rows: (await pool.query(sql, params as unknown[])).rows }),
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn({ query: async (sql, params) => ({ rows: (await c.query(sql, params as unknown[])).rows }) });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

export async function migrate(db: Db) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Run each migration atomically.
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`);
  }
}

/** Transaction-scoped advisory lock: serializes critical sections across processes. */
export async function advisoryXactLock(tx: Tx, name: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
}

export async function getState<T>(db: Tx, key: string): Promise<T | undefined> {
  const r = await db.query<{ value: T }>("SELECT value FROM system_state WHERE key = $1", [key]);
  return r.rows[0]?.value;
}

export async function setState(db: Tx, key: string, value: unknown) {
  await db.query(
    `INSERT INTO system_state(key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function audit(db: Tx, actor: string, action: string, details: Record<string, unknown> = {}) {
  await db.query("INSERT INTO admin_audit(actor, action, details) VALUES ($1,$2,$3::jsonb)", [
    actor,
    action,
    JSON.stringify(details, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ]);
}

export const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(v as string));
export const bigOrNull = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));
