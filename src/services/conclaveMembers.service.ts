import { randomInt } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { auth } from "../config/firebase.js";
import { pgdb } from "../db/client.js";
import { conclaves, registrations, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { ROLE_LOCKED_STATUSES } from "../domain/conclave.js";
import { registrationFeeOf } from "./registration.service.js";
import { normalizePhone } from "./user.service.js";
import type { ConclaveRow } from "./conclave.service.js";

/**
 * Admins adding, editing and removing members of one conclave from the panel.
 *
 * Who may do it:
 * - a superadmin, always;
 * - an admin/coordinator only when a superadmin has switched on
 *   `allowAdminAddMembers` for that conclave.
 * When: only until the schedule is locked and never once the conclave is
 * running, completed or cancelled — after that the seating on every phone
 * would no longer match the member list.
 *
 * Every change is audited.
 */

type AdminRole = string | undefined;
const isSuper = (role: AdminRole) => role === "superadmin";

function membersFrozen(c: Pick<ConclaveRow, "isScheduleLocked" | "status">): string | null {
  if (c.isScheduleLocked) return "The schedule for this conclave is locked, so its member list can no longer change.";
  if (ROLE_LOCKED_STATUSES.has(c.status)) return `This conclave is ${c.status}, so its member list can no longer change.`;
  return null;
}

function assertMayManage(c: ConclaveRow, role: AdminRole) {
  if (!isSuper(role) && !c.allowAdminAddMembers) {
    throw ApiError.forbidden("Adding or changing members of this conclave needs a superadmin to allow it first.");
  }
}

// --- Permission switch --------------------------------------------------------

export async function getPermissions(conclaveId: string, role: AdminRole) {
  const [c] = await pgdb.select().from(conclaves).where(eq(conclaves.id, conclaveId));
  if (!c) throw ApiError.notFound("Conclave not found.");
  const frozen = membersFrozen(c);
  return {
    conclaveId,
    allowAdminAddMembers: c.allowAdminAddMembers,
    isSuperAdmin: isSuper(role),
    isScheduleLocked: c.isScheduleLocked,
    canAddMembers: !frozen && (isSuper(role) || c.allowAdminAddMembers),
    reason: frozen,
  };
}

/** Superadmin only: lets (or stops) the conclave's admins manage its members. */
export async function setPermissions(conclaveId: string, allow: unknown, role: AdminRole) {
  if (!isSuper(role)) throw ApiError.forbidden("Only a superadmin can change this.");
  if (typeof allow !== "boolean") throw ApiError.badRequest("Body must be { allowAdminAddMembers: true | false }.");
  return pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("update");
    if (!before) throw ApiError.notFound("Conclave not found.");
    if (before.allowAdminAddMembers === allow) return { conclaveId, allowAdminAddMembers: allow };
    const [after] = await tx
      .update(conclaves)
      .set({ allowAdminAddMembers: allow, updatedAt: new Date() })
      .where(eq(conclaves.id, conclaveId))
      .returning({ id: conclaves.id, allowAdminAddMembers: conclaves.allowAdminAddMembers });
    await audit.change(
      {
        action: "conclave.set_member_permission",
        entityType: "conclave",
        entityId: conclaveId,
        conclaveId,
        before: { allowAdminAddMembers: before.allowAdminAddMembers },
        after: { allowAdminAddMembers: after.allowAdminAddMembers },
      },
      tx,
    );
    return { conclaveId, allowAdminAddMembers: allow };
  });
}

// --- Add ----------------------------------------------------------------------

const opt = (v: unknown, max = 200) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** A temporary password the admin passes on once; the member should change it. */
function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

async function findExistingUser(email: string | null, phone: string | null, identifier: string | null) {
  const conds = [];
  if (email) conds.push(sql`lower(${users.email}) = ${email}`);
  if (phone) conds.push(eq(users.phone, phone));
  if (identifier) conds.push(sql`lower(${users.identifier}) = ${identifier}`);
  if (!conds.length) return null;
  const [u] = await pgdb.select().from(users).where(or(...conds)).limit(1);
  return u ?? null;
}

export interface AddedMember {
  registration: typeof registrations.$inferSelect;
  /** Set only when a new sign-in was created: give it to the member once. */
  defaultPassword?: string;
  loginIdentifier?: string;
  createdAccount: boolean;
}

export async function addMember(conclaveId: string, body: Record<string, any>, actor: { uid: string; role: AdminRole; email?: string }): Promise<AddedMember> {
  const [c] = await pgdb.select().from(conclaves).where(eq(conclaves.id, conclaveId));
  if (!c) throw ApiError.notFound("Conclave not found.");
  assertMayManage(c, actor.role);
  const frozen = membersFrozen(c);
  if (frozen) throw ApiError.conflict(frozen);

  const name = opt(body.name);
  const email = opt(body.email)?.toLowerCase() ?? null;
  const ph = body.phone || body.mobile ? normalizePhone(body.phone || body.mobile) : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest("Enter a valid email address.");

  // 1. Find the person: by uid, else by email / phone.
  let user = body.userId || body.uid ? (await pgdb.select().from(users).where(eq(users.uid, String(body.userId || body.uid))))[0] ?? null : null;
  if (!user && (body.userId || body.uid)) throw ApiError.notFound("No such member.");
  if (!user) user = await findExistingUser(email, ph?.phone ?? null, ph?.identifier ?? null);

  // 2. Not found: create their sign-in (email account, else phone account).
  let defaultPassword: string | undefined;
  let createdAccount = false;
  let uid = user?.uid;
  if (!uid) {
    if (!name) throw ApiError.badRequest("Enter the member's name.");
    if (!email && !ph) throw ApiError.badRequest("Enter the member's phone number or email, so they can sign in.");
    const signIn = email ?? ph!.identifier;
    try {
      uid = (await auth.getUserByEmail(signIn)).uid; // a login exists without a profile
    } catch {
      defaultPassword = temporaryPassword();
      try {
        uid = (await auth.createUser({ email: signIn, password: defaultPassword, displayName: name })).uid;
        createdAccount = true;
      } catch (err) {
        throw ApiError.badRequest(`Could not create the member's sign-in: ${(err as Error).message}`);
      }
    }
    await pgdb
      .insert(users)
      .values({
        uid,
        name,
        email,
        phone: ph?.phone ?? null,
        identifier: signIn,
        authEmail: signIn,
        company: opt(body.company ?? body.businessName),
        category: opt(body.category ?? body.businessCategory),
        chapter: opt(body.chapter),
        region: opt(body.region) ?? c.region,
        state: opt(body.state),
        country: opt(body.country) ?? "India",
        defaultPasswordAssigned: createdAccount,
      })
      .onConflictDoNothing();
    [user] = await pgdb.select().from(users).where(eq(users.uid, uid));
  }

  // 3. Register them.
  const fee = registrationFeeOf(c);
  const paymentStatus = ["paid", "pending", "failed"].includes(body.paymentStatus) ? String(body.paymentStatus) : fee > 0 ? "pending" : "paid";
  const amount = body.paymentAmount !== undefined && body.paymentAmount !== "" ? Number(body.paymentAmount) || 0 : fee;
  const payment = {
    method: opt(body.paymentMethod, 40) ?? "admin_direct",
    status: paymentStatus,
    amount,
    currency: "INR",
    transactionId: opt(body.transactionId, 64),
    ...(paymentStatus === "paid" ? { paidAt: new Date().toISOString() } : {}),
  };

  const registration = await pgdb.transaction(async (tx) => {
    const [locked] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("share");
    const stillFrozen = locked && membersFrozen(locked);
    if (stillFrozen) throw ApiError.conflict(stillFrozen);
    if (locked?.memberLimit && !isSuper(actor.role)) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(registrations).where(eq(registrations.conclaveId, conclaveId));
      if (n >= locked.memberLimit) throw ApiError.conflict(`This conclave is full (${locked.memberLimit} members).`);
    }
    const [reg] = await tx
      .insert(registrations)
      .values({
        conclaveId,
        userId: uid!,
        role: body.role === "captain" ? "captain" : "member",
        status: "confirmed",
        name: name ?? user?.name ?? null,
        email: email ?? user?.email ?? null,
        phone: ph?.phone ?? user?.phone ?? null,
        company: opt(body.company ?? body.businessName) ?? user?.company ?? null,
        category: opt(body.category ?? body.businessCategory) ?? user?.category ?? null,
        chapter: opt(body.chapter) ?? user?.chapter ?? null,
        region: opt(body.region) ?? user?.region ?? c.region,
        state: opt(body.state) ?? user?.state ?? null,
        country: opt(body.country) ?? user?.country ?? null,
        paymentStatus,
        amountPaid: paymentStatus === "paid" ? amount : null,
        payment,
        addedBy: { uid: actor.uid, email: actor.email ?? null, role: actor.role ?? null, at: new Date().toISOString() },
      })
      .onConflictDoNothing({ target: [registrations.conclaveId, registrations.userId] })
      .returning();
    if (!reg) throw ApiError.conflict("This member is already registered for this conclave.");
    await audit.change(
      { action: "registration.admin_add", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, after: reg, metadata: { createdAccount } },
      tx,
    );
    return reg;
  });

  return {
    registration,
    createdAccount,
    ...(defaultPassword ? { defaultPassword, loginIdentifier: email ?? ph?.tenDigit } : {}),
  };
}

// --- Edit ---------------------------------------------------------------------

const PROFILE_FIELDS = ["name", "company", "category", "chapter", "region", "state", "country"] as const;

export async function updateMember(conclaveId: string, uid: string, body: Record<string, any>, role: AdminRole) {
  return pgdb.transaction(async (tx) => {
    const [c] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("share");
    if (!c) throw ApiError.notFound("Conclave not found.");
    assertMayManage(c, role);
    const where = and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid));
    const [before] = await tx.select().from(registrations).where(where).for("update");
    if (!before) throw ApiError.notFound("That member is not registered for this conclave.");

    const patch: Partial<typeof registrations.$inferInsert> = {};
    const aliases: Record<string, unknown> = { ...body, company: body.company ?? body.businessName, category: body.category ?? body.businessCategory };
    for (const k of PROFILE_FIELDS) if (aliases[k] !== undefined) (patch as any)[k] = opt(aliases[k]);
    if (body.email !== undefined) patch.email = opt(body.email)?.toLowerCase() ?? null;
    if (body.phone !== undefined || body.mobile !== undefined) {
      patch.phone = body.phone || body.mobile ? normalizePhone(body.phone || body.mobile)!.phone : null;
    }

    if (body.role !== undefined) {
      const nextRole = body.role === "captain" ? "captain" : "member";
      if (nextRole !== before.role) {
        const frozen = membersFrozen(c);
        if (frozen) throw ApiError.conflict(frozen);
        patch.role = nextRole;
      }
    }

    if (["paymentStatus", "paymentMethod", "paymentAmount", "transactionId"].some((k) => body[k] !== undefined)) {
      const prev = (before.payment ?? {}) as Record<string, unknown>;
      const status = body.paymentStatus !== undefined ? String(body.paymentStatus) : String(prev.status ?? before.paymentStatus ?? "pending");
      if (!["paid", "pending", "failed", "refunded"].includes(status)) throw ApiError.badRequest("Unknown payment status.");
      const amount = body.paymentAmount !== undefined && body.paymentAmount !== "" ? Number(body.paymentAmount) || 0 : Number(prev.amount ?? 0);
      patch.payment = {
        ...prev,
        status,
        amount,
        ...(body.paymentMethod !== undefined ? { method: opt(body.paymentMethod, 40) } : {}),
        ...(body.transactionId !== undefined ? { transactionId: opt(body.transactionId, 64) } : {}),
        ...(status === "paid" && prev.status !== "paid" ? { paidAt: new Date().toISOString() } : {}),
        updatedAt: new Date().toISOString(),
      };
      patch.paymentStatus = status;
      patch.amountPaid = status === "paid" ? amount : null;
      if (status === "paid" && before.status !== "confirmed") patch.status = "confirmed";
    }

    if (!Object.keys(patch).length) return before;
    const [after] = await tx.update(registrations).set(patch).where(where).returning();
    await audit.change({ action: "registration.admin_update", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, before, after }, tx);

    // Keep the member's own profile in step (not the sign-in address).
    const profilePatch: Partial<typeof users.$inferInsert> = {};
    for (const k of PROFILE_FIELDS) if (patch[k]) (profilePatch as any)[k] = patch[k];
    if (patch.phone) profilePatch.phone = patch.phone;
    if (patch.email) profilePatch.email = patch.email;
    if (Object.keys(profilePatch).length) {
      const [u] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
      if (u) {
        const [uAfter] = await tx.update(users).set({ ...profilePatch, updatedAt: new Date() }).where(eq(users.uid, uid)).returning();
        await audit.change({ action: "user.update", entityType: "user", entityId: uid, before: u, after: uAfter, metadata: { via: "admin_member_edit", conclaveId } }, tx);
      }
    }
    return after;
  });
}

// --- Remove -------------------------------------------------------------------

export async function removeMember(conclaveId: string, uid: string, role: AdminRole) {
  await pgdb.transaction(async (tx) => {
    const [c] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("share");
    if (!c) throw ApiError.notFound("Conclave not found.");
    assertMayManage(c, role);
    const frozen = membersFrozen(c);
    if (frozen) throw ApiError.conflict(frozen);
    const where = and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid));
    const [before] = await tx.select().from(registrations).where(where).for("update");
    if (!before) throw ApiError.notFound("That member is not registered for this conclave.");
    await tx.delete(registrations).where(where);
    await audit.change({ action: "registration.admin_remove", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, before, after: null }, tx);
  });
}

