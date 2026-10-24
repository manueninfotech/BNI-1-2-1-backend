import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * One connection pool per process. Azure Postgres Flexible Server requires TLS;
 * local development (localhost) does not.
 */
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl) ? false : { rejectUnauthorized: true },
});

export const pgdb = drizzle(pool, { schema });
export type Db = typeof pgdb;
export { schema };
