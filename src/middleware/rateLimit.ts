// Named import, not default. The default resolves to the module namespace under
// some TypeScript/interop combinations — it typechecks locally and fails the
// Vercel build with "this expression is not callable". The named export is
// unambiguous everywhere.
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { env } from "../config/env.js";

/**
 * Rate limits.
 *
 * Keyed by the authenticated uid where we have one, so 300 phones behind a single
 * venue NAT — all sharing one public IP — don't throttle each other. Keying by IP
 * would make the venue's own network look like an attacker.
 *
 * The IP fallback (unauthenticated requests, which our routes reject anyway) goes
 * through `ipKeyGenerator`, which normalises IPv6 to a /64 subnet. Using the raw
 * address would let anyone with an IPv6 allocation trivially rotate around the
 * limit, since they typically hold billions of addresses.
 */
const keyByUser = (req: Request) => {
  const uid = (req as Request & { uid?: string }).uid;
  return uid ?? ipKeyGenerator(req.ip ?? "");
};

/**
 * Sync is called every 30s per phone, plus on every reconnect. Generous, but
 * bounded: a looping client must not be able to hammer Firestore.
 */
export const syncLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyByUser,
  skip: () => env.nodeEnv === "development",
  message: { error: "Too many sync requests. Slow down." },
});

/**
 * Payment-order creation. Each call opens a REAL order on Razorpay, so this is
 * tighter than everything else — enough for a member fumbling the flow a few
 * times, low enough that nobody can spin up thousands of orders.
 */
export const paymentOrderLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyByUser,
  skip: () => env.nodeEnv === "development",
  message: { error: "Too many payment attempts. Please wait a few minutes." },
});

/** Everything else: comfortably above real use, low enough to stop a script. */
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyByUser,
  skip: () => env.nodeEnv === "development",
  message: { error: "Too many requests. Slow down." },
});
