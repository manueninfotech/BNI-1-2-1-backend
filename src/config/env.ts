import dotenv from "dotenv";

dotenv.config();

/**
 * Every environment variable the app reads, resolved in one place so nothing
 * else in the codebase reaches for process.env.
 */
export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",

  /**
   * Service account JSON (raw or base64).
   *
   * A serverless deploy has no checked-out repo to read a key file from, so in
   * production the credentials must come from the environment. Locally you can
   * instead point GOOGLE_APPLICATION_CREDENTIALS at a file.
   */
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT ?? "",

  /**
   * Bypasses admin authentication. LOCAL DEVELOPMENT ONLY — it makes every
   * admin endpoint public.
   */
  allowInsecureAdmin: process.env.ALLOW_INSECURE_ADMIN === "true",

  /**
   * Exposes /reset and /stop, which destroy conclave state. Off by default:
   * firing `reset` on a finished event would wipe its schedule and status.
   */
  enableDevRoutes: process.env.ENABLE_DEV_ROUTES === "true",

  corsOrigins: (process.env.CORS_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export const isProduction = env.nodeEnv === "production";
