import { and, eq, notInArray, ne, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, registrations, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { conclaveWindow, windowsOverlap } from "../domain/schedulingRules.js";
import { ROLE_LOCKED_STATUSES, TERMINAL_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow, toView, type ConclaveRow } from "./conclave.service.js";
import { normalizePhone } from "./user.service.js";
import { verifyPayment } from "./razorpay.service.js";

/**
 * Member registration for a conclave.
 *
 * Rules (enforced here, on the server):
 * - registration must be open;
 * - no overlapping conclaves (nobody can attend both, and the schedule has
 *   already paired them);
 * - a paid conclave needs a verified payment that was made by THIS member for
 *   THIS conclave, and each payment can pay for one registration only;
 * - registering twice is idempotent.
 * Every registration (and withdrawal) is audited.
 */

/** The registration fee for a conclave, in rupees. 0 (or unset) means free. */
export function registrationFeeOf(conclave: { paymentDetails?: any; registrationFee?: number | null } | null | undefined): number {
  const fee = Number(conclave?.registrationFee ?? conclave?.paymentDetails?.registrationFee);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function assertOpen(row: ConclaveRow) {
  if (!row.isRegistrationOpen || TERMINAL_STATUSES.has(row.status) || row.status === "ended" || row.status === "running") {
    throw ApiError.conflict("Registration is not open for this conclave.");
  }
}

async function isRegistered(conclaveId: string, uid: string) {
  const [r] = await pgdb
    .select({ u: registrations.userId })
    .from(registrations)
    .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
  return !!r;
}

/** Throws 409 if the member is registered for another live conclave whose time overlaps. */
async function assertNoClash(conclave: ConclaveRow, uid: string) {
  const target = conclaveWindow(toView(conclave));
  if (!target) throw ApiError.conflict("This conclave has no date set yet.");

  const others = await pgdb
    .select({ c: conclaves })
    .from(registrations)
    .innerJoin(conclaves, eq(conclaves.id, registrations.conclaveId))
    .where(and(eq(registrations.userId, uid), ne(conclaves.id, conclave.id), notInArray(conclaves.status, [...TERMINAL_STATUSES])));

  for (const { c } of others) {
    const w = conclaveWindow(toView(c));
    if (!w || !windowsOverlap(target, w)) continue;
    throw ApiError.conflict(
      `This clashes with "${c.name}", which you are already registered for. ` +
        `Two conclaves at the same time cannot both be attended, and registrations cannot be withdrawn.`,
      { conflictsWith: { conclaveId: c.id, name: c.name, venueLocation: c.venueLocation, start: w.start.toISOString(), end: w.end.toISOString() } },
    );
  }
}

/**
 * Everything that must be true before a member may register — also used before
 * opening a Razorpay order, so nobody is charged for a registration that would
 * then be refused.
 */
export async function assertRegisterable(conclaveId: string, uid: string) {
  const { row, data } = await getConclaveOrThrow(conclaveId);
  assertOpen(row);
  if (await isRegistered(conclaveId, uid)) return { conclave: data, row, alreadyRegistered: true as const };
  await assertNoClash(row, uid);
  return { conclave: data, row, alreadyRegistered: false as const };
}

const opt = (v: unknown, max = 200) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

export async function register(conclaveId: string, uid: string, details: Record<string, any> = {}) {
  const check = await assertRegisterable(conclaveId, uid);
  if (check.alreadyRegistered) return { alreadyRegistered: true };

  // --- Payment (verified BEFORE the transaction: it calls Razorpay) ---------
  const fee = registrationFeeOf(check.row);
  const pay = (details.payment ?? {}) as { method?: string; orderId?: string; paymentId?: string; signature?: string };
  let payment: Record<string, unknown> | null = null;
  let paymentStatus: string | null = null;
  let status = "pending";

  if (fee > 0) {
    if (pay.method === "online") {
      await verifyPayment({
        orderId: pay.orderId ?? "",
        paymentId: pay.paymentId ?? "",
        signature: pay.signature ?? "",
        expectedRupees: fee,
        expectedUid: uid,
        expectedConclaveId: conclaveId,
      });
      payment = { method: "online", status: "paid", amount: fee, currency: "INR", orderId: pay.orderId, paymentId: pay.paymentId, paidAt: new Date().toISOString() };
      paymentStatus = "paid";
      status = "confirmed";
    } else if (pay.method === "offline") {
      // Member says they paid by UPI/bank; stays pending until an admin confirms.
      payment = { method: "offline", status: "pending", amount: fee, currency: "INR", utrNumber: opt(details.utrNumber, 64) };
      paymentStatus = "pending";
    } else {
      throw ApiError.badRequest("This conclave requires the registration fee to be paid before registering.", {
        paymentRequired: true,
        registrationFee: fee,
      });
    }
  }

  const phone = details.phone ? normalizePhone(details.phone)?.phone ?? null : null;
  const snapshot = {
    name: opt(details.name),
    email: opt(details.email)?.toLowerCase() ?? null,
    phone,
    company: opt(details.company),
    category: opt(details.category),
    chapter: opt(details.chapter),
    region: opt(details.region),
    state: opt(details.state),
    country: opt(details.country),
    mealPreference: opt(details.mealPreference, 50),
    needsAccommodation: opt(details.needsAccommodation, 50),
    specialInstructions: opt(details.specialInstructions, 1000),
  };

  try {
    return await pgdb.transaction(async (tx) => {
      // Re-check under a lock: registration may have closed since the first check.
      // Lock the conclave row (not just share it) so two last-seat
      // registrations can't both pass the member-limit check.
      const [row] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("update");
      if (!row) throw ApiError.notFound("Conclave not found.");
      assertOpen(row);
      if (row.memberLimit) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(registrations).where(eq(registrations.conclaveId, conclaveId));
        if (n >= row.memberLimit) throw ApiError.conflict(`Sorry, this conclave is full (${row.memberLimit} members).`, { full: true });
      }

      const [reg] = await tx
        .insert(registrations)
        .values({ conclaveId, userId: uid, role: "member", status, paymentStatus, payment, amountPaid: paymentStatus === "paid" ? fee : null, ...snapshot })
        // ONLY the (conclave, member) key — a reused payment id must still fail loudly.
        .onConflictDoNothing({ target: [registrations.conclaveId, registrations.userId] })
        .returning();
      if (!reg) return { alreadyRegistered: true }; // a concurrent request won the race

      await audit.change({ action: "registration.create", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, after: reg }, tx);

      // Keep the member's profile in step with what they registered with.
      const profilePatch: Partial<typeof users.$inferInsert> = {};
      for (const k of ["name", "phone", "company", "category", "chapter", "region", "state", "country"] as const) {
        if (snapshot[k]) (profilePatch as any)[k] = snapshot[k];
      }
      if (Object.keys(profilePatch).length) {
        const [before] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
        if (before) {
          const [after] = await tx.update(users).set({ ...profilePatch, updatedAt: new Date() }).where(eq(users.uid, uid)).returning();
          await audit.change({ action: "user.update", entityType: "user", entityId: uid, before, after, metadata: { via: "registration", conclaveId } }, tx);
        }
      }
      return { alreadyRegistered: false };
    });
  } catch (err) {
    if ((err as any)?.code === "23505" || (err as any)?.cause?.code === "23505") {
      throw ApiError.conflict("This payment has already been used for a registration.");
    }
    throw err;
  }
}

/**
 * A member withdraws their own registration. Allowed only while it can't hurt
 * anyone: before a schedule exists, while registration is still open, and never
 * once paid (refunds go through an admin).
 */
export async function deregister(conclaveId: string, uid: string) {
  await pgdb.transaction(async (tx) => {
    const [c] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("share");
    if (!c) throw ApiError.notFound("Conclave not found.");
    const [reg] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)))
      .for("update");
    if (!reg) throw ApiError.notFound("You are not registered for this conclave.");
    if (c.schedule || ROLE_LOCKED_STATUSES.has(c.status)) {
      throw ApiError.conflict("The schedule has been made, so registrations can no longer be withdrawn.");
    }
    if (reg.paymentStatus === "paid") {
      throw ApiError.conflict("This registration is paid. Please contact the organiser for a refund.");
    }
    await tx.delete(registrations).where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
    await audit.change({ action: "registration.withdraw", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, before: reg, after: null }, tx);
  });
}

/** Registrations per conclave, for counts. */
export async function countRegistrations(conclaveId: string): Promise<number> {
  const [{ n }] = await pgdb.select({ n: sql<number>`count(*)::int` }).from(registrations).where(eq(registrations.conclaveId, conclaveId));
  return n;
}
