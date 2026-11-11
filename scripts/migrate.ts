/** Apply pending SQL migrations: node scripts/migrate.ts */
import { openDb } from "../src/db/index.ts";

const url = process.env.DATABASE_URL;
const db = await openDb(url ? { url } : { dataDir: process.env.PGLITE_DATA_DIR || "./data/pglite" });
const r = await db.query<{ name: string; applied_at: string }>("SELECT name, applied_at FROM schema_migrations ORDER BY name");
for (const m of r.rows) console.log(`applied ${m.name} at ${m.applied_at}`);
await db.close();
