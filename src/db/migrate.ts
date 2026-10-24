import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, pgdb } from "./client.js";

/** Arbitrary but fixed key: only one instance migrates at a time. */
const MIGRATION_LOCK = 4_212_021;

/**
 * Brings the database up to the latest migration (./drizzle). Runs at boot,
 * before the server accepts traffic; a Postgres advisory lock makes it safe
 * when several instances start together (the others wait, then find nothing
 * to do). Migrations are forward-only and reviewed in git like code.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await migrate(pgdb, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
