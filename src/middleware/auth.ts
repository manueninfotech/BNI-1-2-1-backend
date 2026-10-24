import type { NextFunction, Request, Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";
import { auth, db, collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError } from "./errors.js";
import { setActor } from "../observability/context.js";

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
  /** Whether Firebase has verified that email (false/undefined for unverified sign-ups). */
  emailVerified?: boolean;
  params: Record<string, string>;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/**
 * The ONLY way a request becomes authenticated: a Firebase ID token that
 * verifies. Anything else — an email, a uid, a word — is rejected. (Earlier
 * versions accepted an unverifiable token as the uid itself, or as the
 * superadmin if it contained "admin"; that let anyone impersonate anyone.)
 */
async function verify(token: string | null): Promise<DecodedIdToken> {
  if (!token) throw ApiError.unauthorized();
  try {
    return await auth.verifyIdToken(token);
  } catch {
    throw ApiError.unauthorized("Invalid or expired session. Please sign in again.");
  }
}

/**
 * LOCAL DEVELOPMENT ONLY (ALLOW_INSECURE_ADMIN=true, refused in production by
 * env.ts): accept a real token if one is sent, else an X-User-Id header, else a
 * fixed dev identity — so the API can be exercised without Firebase sign-in.
 */
async function insecureDevIdentity(req: Request): Promise<{ uid: string; email?: string }> {
  const token = bearerToken(req);
  if (token) {
    try {
      const d = await auth.verifyIdToken(token);
      return { uid: d.uid, email: d.email };
    } catch {
      /* fall through */
    }
  }
  const headerUid = req.headers["x-user-id"];
  if (typeof headerUid === "string" && headerUid) {
    const headerEmail = req.headers["x-user-email"];
    return { uid: headerUid, email: typeof headerEmail === "string" ? headerEmail : undefined };
  }
  return { uid: "insecure-dev-admin" };
}

/**
 * Authenticates any signed-in user.
 *
 * The uid is taken from the VERIFIED token, never from the request body: a uid
 * in the body is just a string the caller typed.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (env.allowInsecureAdmin) {
    const dev = await insecureDevIdentity(req);
    Object.assign(req, dev);
    setActor({ uid: dev.uid, role: "member", email: dev.email ?? null });
    return next();
  }
  const decoded = await verify(bearerToken(req));
  (req as AuthedRequest).uid = decoded.uid;
  (req as AuthedRequest).email = decoded.email;
  (req as AuthedRequest).emailVerified = decoded.email_verified;
  setActor({ uid: decoded.uid, role: "member", email: decoded.email ?? null, name: decoded.name ?? null });
  next();
}

// ---------------------------------------------------------------------------
// Admin allowlist
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's admin record from the `admins` allowlist, or null.
 *
 * Lookup is by uid. The email fallback (for an admin added by email before
 * their first sign-in) only counts when Firebase has VERIFIED that email, so
 * nobody can claim an admin's address by signing up with it. Being on the list
 * is the only way in — no email-pattern shortcuts.
 *
 * Throws (→ 503) if the lookup itself fails: an outage must deny access, never
 * grant it.
 */
type AdminRecord = { role: string };

const adminCache = new Map<string, { until: number; record: AdminRecord }>();
const ADMIN_TTL_MS = 60_000;

async function adminRecord(uid: string, email?: string, emailVerified?: boolean): Promise<AdminRecord | null> {
  const cached = adminCache.get(uid);
  if (cached && Date.now() < cached.until) return cached.record;

  try {
    const byUid = await db.collection(collections.admins).doc(uid).get();
    let data = byUid.exists ? byUid.data() : undefined;

    if (!data && email && emailVerified) {
      const byEmail = await db
        .collection(collections.admins)
        .where("email", "==", email.toLowerCase().trim())
        .limit(1)
        .get();
      if (!byEmail.empty) {
        data = byEmail.docs[0].data();
        // Link the record to this uid so later lookups hit the fast path.
        await db.collection(collections.admins).doc(uid)
          .set({ ...data, uid, updatedAt: new Date() }, { merge: true })
          .catch(() => {});
      }
    }

    if (!data) {
      adminCache.delete(uid);
      return null;
    }
    const record = { role: String(data.role ?? "admin").toLowerCase() };
    adminCache.set(uid, { until: Date.now() + ADMIN_TTL_MS, record });
    return record;
  } catch (err) {
    console.error("Admin allowlist lookup failed:", (err as Error)?.message ?? err);
    throw new ApiError(503, "Couldn't verify admin access right now. Please try again.");
  }
}

/** True if the uid is on the admins allowlist. */
export async function isAdmin(uid: string, email?: string, emailVerified?: boolean): Promise<boolean> {
  if (env.allowInsecureAdmin) return true;
  return (await adminRecord(uid, email, emailVerified)) !== null;
}

/**
 * Authenticates an admin: a verified Firebase token whose uid is on the
 * admins allowlist.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (env.allowInsecureAdmin) {
    const dev = await insecureDevIdentity(req);
    Object.assign(req, dev);
    setActor({ uid: dev.uid, role: "admin", email: dev.email ?? null, name: "insecure-dev" });
    return next();
  }
  const decoded = await verify(bearerToken(req));
  // Record who is trying before deciding, so a refused attempt is attributed.
  setActor({ uid: decoded.uid, role: "member", email: decoded.email ?? null, name: decoded.name ?? null });
  const record = await adminRecord(decoded.uid, decoded.email, decoded.email_verified);
  if (!record) {
    throw ApiError.forbidden("You are not an administrator.");
  }
  setActor({ uid: decoded.uid, role: record.role, email: decoded.email ?? null, name: decoded.name ?? null });
  (req as AuthedRequest).uid = decoded.uid;
  (req as AuthedRequest).email = decoded.email;
  next();
}

/**
 * Gates a route to superadmins only. Mounted AFTER requireAdmin, so req.uid is
 * a verified admin. Used for the platform-wide revenue endpoints.
 */
export async function requireSuperadmin(req: Request, _res: Response, next: NextFunction) {
  if (env.allowInsecureAdmin) return next();
  const { uid } = req as AuthedRequest;
  const record = await adminRecord(uid);
  if (record?.role !== "superadmin") {
    throw ApiError.forbidden("This area is restricted to the platform superadmin.");
  }
  next();
}

/**
 * Gates a route to specific admin roles (e.g. keep coordinators out of the
 * platform-wide audit log). Mounted AFTER requireAdmin.
 */
export function requireRole(...roles: string[]) {
  const allowed = new Set(roles.map((r) => r.toLowerCase()));
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (env.allowInsecureAdmin) return next();
    const record = await adminRecord((req as AuthedRequest).uid);
    if (!record || !allowed.has(record.role)) {
      throw ApiError.forbidden("You don't have access to this area.");
    }
    next();
  };
}
