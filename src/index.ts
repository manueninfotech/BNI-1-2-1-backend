process.env.TZ = process.env.TZ || "Asia/Kolkata";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startReminderScheduler } from "./services/oneToOnes.service.js";
import { startAutoCompleteSweep } from "./services/autocomplete.service.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/client.js";

/**
 * Local development entrypoint.
 *
 * Vercel does not run this — it imports the app from api/index.ts and owns the
 * listener itself. Keeping the two apart means neither has to know about the
 * other.
 */
async function main() {
  // Schema first: never serve traffic against an out-of-date database.
  await runMigrations();
  const app = createApp();
  const server = app.listen(env.port, () => {
  console.log(`Conclave API listening on http://localhost:${env.port}`);
  if (env.allowInsecureAdmin) {
    console.warn(
      "\n*** ALLOW_INSECURE_ADMIN=true — admin endpoints are UNAUTHENTICATED. Never do this in production. ***\n",
    );
  }
  if (env.enableDevRoutes) {
    console.warn("*** ENABLE_DEV_ROUTES=true — destructive dev routes are exposed. ***");
  }

  // In-process scheduler for 1-2-1 reminders. No external cron needed.
  startReminderScheduler();

  // In-process sweep that completes conclaves whose auto-advancing rounds have
  // all elapsed (and clears any stale 'running'). No external cron needed.
  startAutoCompleteSweep();
  });

  // Graceful shutdown: Container Apps sends SIGTERM before replacing a revision.
  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: (err as Error)?.message, stack: (err as Error)?.stack }));
  process.exit(1);
});
