import { createApp } from "./app.js";
import { env } from "./config/env.js";

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
});
