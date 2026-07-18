import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { generalLimiter } from "./middleware/rateLimit.js";
import adminRoutes from "./routes/admin.routes.js";
import memberRoutes from "./routes/member.routes.js";

/**
 * Builds the Express app.
 *
 * Kept separate from the server entrypoint so the same app can be listened on
 * locally (`npm run dev`) and exported as a serverless handler on Vercel, with
 * no branching inside the app itself.
 */
export function createApp() {
  const app = express();

  // Vercel and most hosts sit behind a proxy; without this the rate limiter and
  // request IPs see the proxy rather than the client.
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: env.corsOrigins.includes("*") ? true : env.corsOrigins,
    }),
  );
  app.use(express.json({ limit: "2mb" })); // a captain's offline batch can be large

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use(generalLimiter);

  // Member endpoints (authenticated members). Mounted before /api/admin so the
  // paths don't collide.
  app.use("/api", memberRoutes);

  // Admin endpoints (authenticated administrators).
  app.use("/api/admin", adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
