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
  const token = bearerToken(req);
  if (!token) {
    if (env.allowInsecureAdmin) {
      (req as AuthedRequest).uid = "insecure-dev-admin";
      return next();
    }
    throw ApiError.unauthorized();
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    (req as AuthedRequest).uid = decoded.uid;
    next();
  } catch {
    throw ApiError.unauthorized("Invalid or expired session.");
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

export async function isAdmin(uid: string): Promise<boolean> {
  const cachedUntil = adminCache.get(uid);
  if (cachedUntil !== undefined && Date.now() < cachedUntil) return true;

  const doc = await db.collection(collections.admins).doc(uid).get();
  if (doc.exists) {
    adminCache.set(uid, Date.now() + ADMIN_TTL_MS);
    return true;
  }
  adminCache.delete(uid);
  return false;
}

/**
 * Authenticates an admin.
 *
 * Two independent facts are required: a valid Firebase token (proves who you
 * are) AND an `admins/{uid}` document (proves you were granted access). Being
 * signed in is not enough — the allowlist document IS the grant, and it is
 * written by hand via `npm run create-admin`.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) {
    if (env.allowInsecureAdmin) {
      (req as AuthedRequest).uid = "insecure-dev-admin";
      return next();
    }
    throw ApiError.unauthorized("Missing admin credentials.");
  }

  let uid: string;
  try {
    uid = (await auth.verifyIdToken(token)).uid;
  } catch {
    throw ApiError.unauthorized("Invalid or expired admin token.");
  }

  if (!(await isAdmin(uid))) {
    throw ApiError.forbidden("You are not an administrator.");
  }

  (req as AuthedRequest).uid = uid;
  next();
}
