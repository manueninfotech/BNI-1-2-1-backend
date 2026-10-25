import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Brings the test database up to the latest migration once per test run.
 * Tests isolate themselves by unique ids (audit_log can't be truncated — it is
 * append-only by design), so no global wipe is needed.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/conclave_test";
  if (!/localhost|127\.0\.0\.1/.test(url) && !process.env.CI) {
    throw new Error(`Refusing to run tests against a non-local database: ${url}`);
  }
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
}
