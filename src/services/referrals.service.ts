import { and, desc, eq, or } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { attendance, conclaves, referrals } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { fetchUsers } from "./user.service.js";

/**
 * Referrals (business promises made face to face at a table) and the admin
 * attendance view. Referrals are immutable once given; only the RECEIVER
 * records the business outcome. Every outcome change is audited.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Referrals in a conclave that the caller gave or received (members see only their own). */
export async function listMineInConclave(conclaveId: string, uid: string) {
  const rows = await pgdb
    .select()
    .from(referrals)
    .where(and(eq(referrals.conclaveId, conclaveId), or(eq(referrals.fromUserId, uid), eq(referrals.toUserId, uid))))
    .orderBy(desc(referrals.createdAt));
  return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), outcomeAt: iso(r.outcomeAt), syncedAt: iso(r.syncedAt) }));
}

/** The member's referral network across every conclave: given and received. */
export async function myReferrals(uid: string) {
  const rows = await pgdb
    .select({ r: referrals, conclaveName: conclaves.name })
    .from(referrals)
    .innerJoin(conclaves, eq(conclaves.id, referrals.conclaveId))
    .where(or(eq(referrals.fromUserId, uid), eq(referrals.toUserId, uid)));

  const others = rows.map(({ r }) => (r.fromUserId === uid ? r.toUserId : r.fromUserId));
  const people = await fetchUsers(others);

  const toRow = ({ r, conclaveName }: (typeof rows)[number], otherUserId: string, storedName: string | null) => {
    const u = people.get(otherUserId);
    return {
      id: r.id,
      conclaveId: r.conclaveId,
      conclaveName: conclaveName || "Conclave",
      roundNumber: r.roundNumber,
      otherUserId,
      otherName: storedName || u?.name || "",
      otherBusinessName: u?.company ?? "",
      notes: r.notes,
      status: r.status || "Pending",
      outcome: r.outcome || "open",
      closedAmount: Number(r.closedAmount ?? 0),
      outcomeNote: r.outcomeNote ?? "",
      outcomeAt: iso(r.outcomeAt),
      createdAt: (r.createdAt ?? r.syncedAt).toISOString(),
    };
  };

  const given = rows.filter((x) => x.r.fromUserId === uid).map((x) => toRow(x, x.r.toUserId, x.r.toName));
  const received = rows.filter((x) => x.r.toUserId === uid && x.r.fromUserId !== uid).map((x) => toRow(x, x.r.fromUserId, x.r.fromName));
  const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
  return { given: given.sort(byNewest), received: received.sort(byNewest) };
}

export const OUTCOMES = new Set(["open", "accepted", "closed", "not_closed"]);

/**
 * The receiver reports what happened: accepted, closed (with the TYFCB amount),
 * or didn't work out. Only the receiver may, and it's audited.
 */
export async function updateOutcome(conclaveId: string, referralId: string, uid: string, input: { outcome?: unknown; amount?: unknown; note?: unknown }) {
  const outcome = String(input.outcome ?? "").trim();
  const amount = Number(input.amount ?? 0);
  const note = String(input.note ?? "").trim().slice(0, 1000);
  if (!OUTCOMES.has(outcome)) throw ApiError.badRequest("Invalid outcome.");
  if (outcome === "closed" && (!Number.isFinite(amount) || amount < 0)) throw ApiError.badRequest("A closed referral needs a valid amount.");

  return pgdb.transaction(async (tx) => {
    const where = and(eq(referrals.conclaveId, conclaveId), eq(referrals.id, referralId));
    const [before] = await tx.select().from(referrals).where(where).for("update");
    if (!before) throw ApiError.notFound("Referral not found.");
    if (before.toUserId !== uid) throw ApiError.forbidden("Only the member who received a referral can update it.");

    const status = outcome === "accepted" || outcome === "closed" ? "Completed" : before.status || "Pending";
    const closedAmount = outcome === "closed" ? amount : 0;
    const [after] = await tx
      .update(referrals)
      .set({ outcome, status, closedAmount, outcomeNote: note, outcomeAt: new Date() })
      .where(where)
      .returning();
    await audit.change({ action: "referral.outcome", entityType: "referral", entityId: referralId, conclaveId, before, after }, tx);
    return { ok: true, outcome, status, closedAmount };
  });
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

/** Every referral in a conclave, with names and categories resolved. */
export async function listForAdmin(conclaveId: string) {
  const rows = await pgdb.select().from(referrals).where(eq(referrals.conclaveId, conclaveId)).orderBy(desc(referrals.createdAt));
  const people = await fetchUsers(rows.flatMap((r) => [r.fromUserId, r.toUserId]));
  return rows.map((r) => {
    const from = people.get(r.fromUserId);
    const to = people.get(r.toUserId);
    return {
      id: r.id,
      conclaveId,
      fromMemberId: r.fromUserId,
      fromName: from?.name || r.fromName || "BNI Member",
      fromCategory: from?.category || "BNI Member",
      toMemberId: r.toUserId,
      toName: to?.name || r.toName || "BNI Member",
      toCategory: to?.category || "BNI Member",
      roundNumber: r.roundNumber,
      notes: r.notes,
      status: r.status || "Pending",
      outcome: r.outcome,
      closedAmount: r.closedAmount,
      createdAt: iso(r.createdAt),
    };
  });
}

/** Every attendance mark in a conclave, with names resolved. */
export async function listAttendanceForAdmin(conclaveId: string) {
  const rows = await pgdb.select().from(attendance).where(eq(attendance.conclaveId, conclaveId));
  const people = await fetchUsers(rows.map((r) => r.userId));
  return rows.map((a) => {
    const u = people.get(a.userId);
    return {
      id: a.id,
      userId: a.userId,
      userName: u?.name || "Member",
      userCategory: u?.category || "BNI Member",
      roundNumber: a.roundNumber,
      tableNumber: a.tableNumber,
      isPresent: a.isPresent,
      source: a.source,
      markedBy: a.markedBy || a.userId,
      markedAt: iso(a.markedAt),
    };
  });
}
