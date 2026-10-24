import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { asyncHandler, errorHandler, notFoundHandler } from "./middleware/errors.js";
import { signedLink } from "./services/storage.service.js";
import { generalLimiter } from "./middleware/rateLimit.js";
import { requestContext } from "./middleware/requestContext.js";
import adminRoutes from "./routes/admin.routes.js";
import memberRoutes from "./routes/member.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";


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

  // Request id + caller context + automatic audit of every state-changing call.
  // First, so even rejected and malformed requests are traced.
  app.use(requestContext);

  app.use(
    cors({
      origin: env.corsOrigins.includes("*") ? true : env.corsOrigins,
    }),
  );
  // Keep the raw request bytes alongside the parsed JSON: a Razorpay webhook's
  // signature is an HMAC over the EXACT body it sent, so verifying it against a
  // re-serialised object would fail on any key-ordering or spacing difference.
  app.use(
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // Stored files: a short-lived signed link to a private blob (see storage.service).
  app.get(
    "/api/files/*path",
    asyncHandler(async (req, res) => {
      const raw = (req.params as { path?: string | string[] }).path;
      const path = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
      const link = await signedLink(path);
      if (!link) return res.status(404).json({ error: "File not found." });
      res.setHeader("Cache-Control", "private, no-store");
      res.redirect(302, link);
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Razorpay webhooks: public (Razorpay has no bearer token — it proves itself
  // with the signature) and mounted BEFORE the general rate limiter, so a burst
  // of payment events is never dropped.
  app.use("/api/webhooks", webhookRoutes);

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
