import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startReminderScheduler } from "./services/reminder.service.js";
import { startAutoCompleteSweep } from "./services/autocomplete.service.js";

/**
 * Local development entrypoint.
 *
 * Vercel does not run this — it imports the app from api/index.ts and owns the
 * listener itself. Keeping the two apart means neither has to know about the
 * other.
 */
const app = createApp();

app.listen(env.port, () => {
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
