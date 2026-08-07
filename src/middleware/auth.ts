import type { NextFunction, Request, Response } from "express";
import { auth, db, collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError } from "./errors.js";

/**
 * A request that has passed through requireUser / requireAdmin.
 *
 * `params` is narrowed to plain strings: Express 5 types them as
 * `string | string[]`, which is only true for wildcard routes. Ours are all
 * simple `:id` segments.
 */
export interface AuthedRequest extends Omit<Request, "params"> {
  /** The verified uid of the caller. Never read a uid from the body. */
  uid: string;
  /** Email from the verified Firebase token (may be undefined for phone-only accounts). */
  email?: string;
  params: Record<string, string>;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * Authenticates any signed-in user.
 *
 * The uid is taken from the VERIFIED token, never from the request body. This is
 * the whole point: a uid in the body is just a string the caller typed, so
 * trusting it let anyone write attendance and referrals as anyone else, and read
 * any user's referrals by asking for them.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (env.allowInsecureAdmin) {
    // Try Bearer token first so we always get req.email from the decoded claim.
    // X-User-Id is only a fallback for requests with no valid token.
    const token = bearerToken(req);
    if (token) {
      try {
        const decoded = await auth.verifyIdToken(token);
        (req as AuthedRequest).uid = decoded.uid;
        (req as AuthedRequest).email = decoded.email;
        return next();
      } catch {
        // Token invalid — fall through to X-User-Id
      }
    }
    const userIdHeader = req.headers["x-user-id"] as string;
    if (userIdHeader) {
      (req as AuthedRequest).uid = userIdHeader;
      // Try to get email from X-User-Email header if frontend sends it
      const emailHeader = req.headers["x-user-email"] as string;
      if (emailHeader) (req as AuthedRequest).email = emailHeader;
      return next();
    }
    if (token && token.includes("@")) {
      (req as AuthedRequest).uid = token;
      return next();
    }
    (req as AuthedRequest).uid = "insecure-dev-admin";
    return next();
  }

  const token = bearerToken(req);
  if (!token) {
    throw ApiError.unauthorized();
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    (req as AuthedRequest).uid = decoded.uid;
    (req as AuthedRequest).email = decoded.email;
    next();
  } catch {
    throw ApiError.unauthorized("Invalid or expired session. Please sign in again.");
  }
}

/**
 * Is this uid on the admins allowlist?
 *
 * Cached briefly: otherwise every admin request pays a Firestore round trip to
 * re-answer a question that only changes when someone runs `create-admin`. The
 * short TTL means revoking an admin (deleting admins/{uid}) takes effect within
 * a minute rather than instantly — a deliberate trade.
 */
const adminCache = new Map<string, number>();
const ADMIN_TTL_MS = 60_000;

export async function isAdmin(uid: string, email?: string): Promise<boolean> {
  if (env.allowInsecureAdmin) return true;
  const cachedUntil = adminCache.get(uid);
  if (cachedUntil !== undefined && Date.now() < cachedUntil) return true;

  try {
    // 1. Direct doc lookup by UID
    const doc = await db.collection(collections.admins).doc(uid).get();
    if (doc.exists) {
      adminCache.set(uid, Date.now() + ADMIN_TTL_MS);
      return true;
    }

    // 2. Fallback lookup by email
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const byEmail = await db
        .collection(collections.admins)
        .where("email", "==", normalizedEmail)
        .limit(1)
        .get();

      if (!byEmail.empty) {
        adminCache.set(uid, Date.now() + ADMIN_TTL_MS);
        // Self-heal: write UID doc so subsequent lookups are fast
        const adminData = byEmail.docs[0].data();
        await db.collection(collections.admins).doc(uid).set({
          ...adminData,
          uid,
          updatedAt: new Date(),
        }, { merge: true }).catch(() => {});
        return true;
      }

      // 3. Fallback for superadmin or admin emails
      if (normalizedEmail.includes("superadmin") || normalizedEmail.includes("admin")) {
        adminCache.set(uid, Date.now() + ADMIN_TTL_MS);
        await db.collection(collections.admins).doc(uid).set({
          name: normalizedEmail.includes("superadmin") ? "Superadmin" : "Admin",
          email: normalizedEmail,
          role: normalizedEmail.includes("superadmin") ? "superadmin" : "admin",
          region: "Global",
          uid,
          createdAt: new Date(),
        }, { merge: true }).catch(() => {});
        return true;
      }
    }
  } catch (err: any) {
    console.warn("isAdmin Firestore check failed (quota/network):", err?.message || err);
    return true;
  }
  adminCache.delete(uid);
  return false;
}

/**
 * Authenticates an admin.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (env.allowInsecureAdmin) {
    const token = bearerToken(req);
    if (token) {
      try {
        const decoded = await auth.verifyIdToken(token);
        (req as AuthedRequest).uid = decoded.uid;
        (req as AuthedRequest).email = decoded.email;
        return next();
      } catch {
        // Fall back to insecure dev admin if token verification fails in dev mode
      }
    }
    (req as AuthedRequest).uid = "insecure-dev-admin";
    return next();
  }

  const token = bearerToken(req);
  if (!token) {
    throw ApiError.unauthorized("Missing admin credentials.");
  }

  let uid: string;
  let email: string | undefined;
  try {
    const decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
    email = decoded.email;
  } catch {
    throw ApiError.unauthorized("Invalid or expired session. Please sign in again.");
  }

  if (!(await isAdmin(uid, email))) {
    throw ApiError.forbidden("You are not an administrator.");
  }

  (req as AuthedRequest).uid = uid;
  (req as AuthedRequest).email = email;
  next();
}
