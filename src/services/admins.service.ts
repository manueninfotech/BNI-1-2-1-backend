import { asc, eq, ne, sql } from "drizzle-orm";
import { auth } from "../config/firebase.js";
import { pgdb } from "../db/client.js";
import { admins } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Admin-panel accounts (superadmin / admin / coordinator) and the rules for who
 * may manage whom. Login stays on Firebase Auth; this table is the allowlist.
 *
 * Permission matrix (enforced here, not just in the UI):
 *   superadmin → may manage anyone, grant any role
 *   admin      → may manage coordinators only
 *   coordinator→ may manage nobody
 * Nobody may delete or demote themselves.
 */

export type AdminRole = "coordinator" | "admin" | "superadmin";
const RANK: Record<AdminRole, number> = { coordinator: 1, admin: 2, superadmin: 3 };
const STATUSES = new Set(["Active", "Inactive"]);

export interface AdminRecord {
  uid: string;
  role: AdminRole;
  email: string;
  name: string;
  region: string | null;
  status: string;
}

function asRole(v: unknown): AdminRole {
  const r = String(v ?? "").toLowerCase();
  if (r in RANK) return r as AdminRole;
  throw ApiError.badRequest(`role must be one of: ${Object.keys(RANK).join(", ")}.`);
}
const toRecord = (r: typeof admins.$inferSelect): AdminRecord => ({
  uid: r.uid,
  role: (r.role in RANK ? r.role : "coordinator") as AdminRole,
  email: r.email,
  name: r.name,
  region: r.region,
  status: r.status,
});

/** May `actor` manage (create / edit / reset / delete) an account with `target` role? */
export function canManage(actor: AdminRole, target: AdminRole): boolean {
  return actor === "superadmin" || (actor === "admin" && target === "coordinator");
}

// ---------------------------------------------------------------------------
// Lookup for the auth middleware
// ---------------------------------------------------------------------------

/**
 * The allowlist record for a signed-in user, or null.
 *
 * By uid first. An admin added by email before their first sign-in is matched
 * by email ONLY when Firebase verified that email, and the row is then re-keyed
 * to the real uid (audited) — rather than duplicated, which is how the old
 * Firestore data ended up with two superadmin records.
 * Inactive admins are refused.
 */
export async function findActiveAdmin(uid: string, email?: string, emailVerified?: boolean): Promise<AdminRecord | null> {
  let [row] = await pgdb.select().from(admins).where(eq(admins.uid, uid));

  if (!row && email && emailVerified) {
    const [byEmail] = await pgdb.select().from(admins).where(sql`lower(${admins.email}) = ${email.toLowerCase().trim()}`);
    if (byEmail) {
      row = await pgdb.transaction(async (tx) => {
        const [linked] = await tx.update(admins).set({ uid, updatedAt: new Date() }).where(eq(admins.uid, byEmail.uid)).returning();
        await audit.change(
          { action: "admin.link", entityType: "admin", entityId: uid, before: { uid: byEmail.uid }, after: { uid }, metadata: { email } },
          tx,
        );
        return linked;
      });
    }
  }

  if (!row || row.status !== "Active") return null;
  return toRecord(row);
}

// ---------------------------------------------------------------------------
// Management (admin panel → Coordinators)
// ---------------------------------------------------------------------------

async function getOrThrow(uid: string) {
  const [row] = await pgdb.select().from(admins).where(eq(admins.uid, uid));
  if (!row) throw ApiError.notFound("Admin account not found.");
  return row;
}

function assertCanManage(actor: AdminRecord, targetRole: AdminRole) {
  if (!canManage(actor.role, targetRole)) {
    throw ApiError.forbidden(`A ${actor.role} can't manage ${targetRole} accounts.`);
  }
}

function formatPhone(raw: unknown): string {
  const p = String(raw ?? "").trim();
  if (!p) return "";
  if (!p.startsWith("+") && /^\d{10}$/.test(p)) return `+91${p}`;
  return p;
}

/** Everyone the caller may see — superadmins are listed only to superadmins. */
export async function listAdmins(actor: AdminRecord) {
  const rows = await pgdb
    .select()
    .from(admins)
    .where(actor.role === "superadmin" ? undefined : ne(admins.role, "superadmin"))
    .orderBy(asc(admins.name));
  return rows.map((r) => ({
    uid: r.uid,
    email: r.email,
    name: r.name,
    mobile: r.phone ?? "",
    region: r.region,
    status: r.status,
    role: r.role,
    organization: r.organization,
    designation: r.designation,
    chapter: r.chapter,
    grantedAt: r.grantedAt.toISOString(),
  }));
}

export interface CreateAdminInput {
  email?: unknown;
  password?: unknown;
  name?: unknown;
  mobile?: unknown;
  region?: unknown;
  status?: unknown;
  role?: unknown;
}

export async function createAdmin(actor: AdminRecord, input: CreateAdminInput): Promise<{ uid: string }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const name = String(input.name ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest("A valid email is required.");
  if (password.length < 8) throw ApiError.badRequest("Password must be at least 8 characters.");
  if (!name) throw ApiError.badRequest("Name is required.");
  const role = input.role === undefined ? "coordinator" : asRole(input.role);
  assertCanManage(actor, role);
  const status = input.status === undefined ? "Active" : String(input.status);
  if (!STATUSES.has(status)) throw ApiError.badRequest("status must be Active or Inactive.");
  const phone = formatPhone(input.mobile);

  // 1. Firebase login.
  let uid: string;
  try {
    const user = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: true,
      ...(phone ? { phoneNumber: phone } : {}),
    });
    uid = user.uid;
  } catch (err) {
    throw ApiError.badRequest((err as Error).message || "Failed to create the login.");
  }

  // 2. Allowlist row + audit. If this fails, remove the login so no orphan
  //    account is left able to sign in to nothing.
  try {
    await pgdb.transaction(async (tx) => {
      const [row] = await tx
        .insert(admins)
        .values({ uid, email, name, phone: phone || null, region: String(input.region ?? "") || null, status, role })
        .returning();
      await audit.change({ action: "admin.create", entityType: "admin", entityId: uid, after: row }, tx);
    });
  } catch (err) {
    await auth.deleteUser(uid).catch(() => {});
    if ((err as any)?.code === "23505" || (err as any)?.cause?.code === "23505") {
      throw ApiError.conflict("An admin with that email already exists.");
    }
    throw err;
  }
  return { uid };
}

export interface UpdateAdminInput {
  name?: unknown;
  mobile?: unknown;
  region?: unknown;
  status?: unknown;
  role?: unknown;
}

export async function updateAdmin(actor: AdminRecord, uid: string, input: UpdateAdminInput): Promise<void> {
  const target = await getOrThrow(uid);
  assertCanManage(actor, toRecord(target).role);

  const patch: Partial<typeof admins.$inferInsert> = {};
  if (input.name !== undefined) {
    const n = String(input.name).trim();
    if (!n) throw ApiError.badRequest("Name can't be empty.");
    patch.name = n;
  }
  if (input.mobile !== undefined) patch.phone = formatPhone(input.mobile) || null;
  if (input.region !== undefined) patch.region = String(input.region) || null;
  if (input.status !== undefined) {
    const s = String(input.status);
    if (!STATUSES.has(s)) throw ApiError.badRequest("status must be Active or Inactive.");
    if (uid === actor.uid && s !== "Active") throw ApiError.badRequest("You can't deactivate your own account.");
    patch.status = s;
  }
  if (input.role !== undefined) {
    const r = asRole(input.role);
    assertCanManage(actor, r);
    if (uid === actor.uid && RANK[r] < RANK[actor.role]) throw ApiError.badRequest("You can't demote yourself.");
    patch.role = r;
  }
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nothing to update.");

  await pgdb.transaction(async (tx) => {
    const [after] = await tx.update(admins).set({ ...patch, updatedAt: new Date() }).where(eq(admins.uid, uid)).returning();
    await audit.change({ action: "admin.update", entityType: "admin", entityId: uid, before: target, after }, tx);
  });

  // Keep the Firebase profile in step (best-effort; the allowlist is the source of truth).
  const authPatch: { displayName?: string; phoneNumber?: string | null } = {};
  if (patch.name) authPatch.displayName = patch.name;
  if (input.mobile !== undefined) authPatch.phoneNumber = patch.phone ?? null;
  if (Object.keys(authPatch).length) {
    await auth.updateUser(uid, authPatch).catch((e) =>
      console.warn(JSON.stringify({ level: "warn", msg: "firebase profile update failed", uid, err: (e as Error).message })),
    );
  }
}

export async function resetAdminPassword(actor: AdminRecord, uid: string, password: unknown): Promise<void> {
  const target = await getOrThrow(uid);
  assertCanManage(actor, toRecord(target).role);
  const pw = String(password ?? "");
  if (pw.length < 8) throw ApiError.badRequest("Password must be at least 8 characters.");
  await auth.updateUser(uid, { password: pw });
  // The password itself is never recorded — only that it was reset, and by whom.
  await audit.change({ action: "admin.reset_password", entityType: "admin", entityId: uid, metadata: { targetEmail: target.email } });
}

export async function deleteAdmin(actor: AdminRecord, uid: string): Promise<void> {
  if (uid === actor.uid) throw ApiError.badRequest("You can't remove your own access.");
  const target = await getOrThrow(uid);
  assertCanManage(actor, toRecord(target).role);
  await pgdb.transaction(async (tx) => {
    await tx.delete(admins).where(eq(admins.uid, uid));
    await audit.change({ action: "admin.delete", entityType: "admin", entityId: uid, before: target, after: null }, tx);
  });
  await auth.deleteUser(uid).catch((e) =>
    console.warn(JSON.stringify({ level: "warn", msg: "firebase user delete failed", uid, err: (e as Error).message })),
  );
}
