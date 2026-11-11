import { and, eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, registrations } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { ConclaveStatus } from "../domain/conclave.js";
import type { ServerParticipant } from "../domain/captains.js";
import { joinsFromRound, planWithWalkIns, WalkInPlanError } from "../domain/walkIns.js";
import type { Schedule } from "../engine/index.js";
import { fetchUsers } from "./user.service.js";
import { notifyUser } from "./notification.service.js";
import { notifyConclaveChanged } from "./live.service.js";
import { registrationFeeOf, SPECIFIC_ASK_MAX } from "./registration.service.js";

/**
 * Walk-ins: people who join at the venue after the conclave has started.
 *
 *   1. The member taps "Join as walk-in" in the app (no payment in the app).
 *   2. The region admin approves (payment collected by them, outside the app)
 *      or rejects it in the admin panel.
 *   3. On approval they are seated from the next safe round; tables stay even
 *      and a new table opens (with an admin-picked captain) only when full.
 *
 * Normal registration stays closed once the conclave starts; this is the only
 * way in.
 */

const opt = (v: unknown, max = 200) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** The member asks to join a running conclave. Idempotent. */
export async function requestWalkIn(conclaveId: string, uid: string, details: { specificAsk?: unknown } = {}) {
  const users = await fetchUsers([uid]);
  const u = users.get(uid);
  if (!u) throw ApiError.notFound("Your profile wasn't found. Please sign in again.");
  if (!opt(u.category)) {
    throw ApiError.badRequest("Add your business category to your profile first, so we can seat you well.", { needsCategory: true });
  }

  return pgdb.transaction(async (tx) => {
    const [c] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("update");
    if (!c) throw ApiError.notFound("Conclave not found.");
    if (c.status !== ConclaveStatus.running) throw ApiError.conflict("Walk-ins can join only while the conclave is running.");
    if (joinsFromRound(c) === null) throw ApiError.conflict("The last round has started, so there's no round left to join.");

    const [existing] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
    if (existing) {
      if (existing.isWalkIn) return { status: existing.walkInStatus ?? "pending", joinsFromRound: existing.joinsFromRound };
      return { status: "registered", joinsFromRound: null };
    }
    if (c.memberLimit) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(registrations).where(eq(registrations.conclaveId, conclaveId));
      if (n >= c.memberLimit) throw ApiError.conflict(`Sorry, this conclave is full (${c.memberLimit} members).`, { full: true });
    }

    const [reg] = await tx
      .insert(registrations)
      .values({
        conclaveId,
        userId: uid,
        role: "member",
        status: "pending",
        isWalkIn: true,
        walkInStatus: "pending",
        paymentStatus: registrationFeeOf(c) > 0 ? "pending" : null,
        name: opt(u.name),
        email: opt(u.email)?.toLowerCase() ?? null,
        phone: opt(u.phone),
        company: opt(u.company),
        category: opt(u.category),
        chapter: opt(u.chapter),
        region: opt(u.region),
        specificAsk: opt(details.specificAsk, SPECIFIC_ASK_MAX),
      })
      .onConflictDoNothing({ target: [registrations.conclaveId, registrations.userId] })
      .returning();
    if (reg) {
      await audit.change({ action: "walk_in.request", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, after: reg }, tx);
      await notifyConclaveChanged(tx, conclaveId);
    }
    return { status: "pending", joinsFromRound: null };
  });
}

/** Walk-in requests for the admin panel, newest first. */
export async function listWalkIns(conclaveId: string) {
  const rows = await pgdb
    .select()
    .from(registrations)
    .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.isWalkIn, true)));
  const users = await fetchUsers(rows.map((r) => r.userId));
  return rows
    .map((r) => {
      const u = users.get(r.userId);
      return {
        uid: r.userId,
        name: u?.name ?? r.name ?? "",
        phone: u?.phone ?? r.phone ?? "",
        company: u?.company ?? r.company ?? "",
        category: u?.category ?? r.category ?? "",
        chapter: u?.chapter ?? r.chapter ?? "",
        membership: u?.membership ?? "",
        status: r.walkInStatus ?? "pending",
        joinsFromRound: r.joinsFromRound,
        tableNumber: r.tableNumber,
        requestedAt: r.registeredAt.toISOString(),
      };
    })
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/**
 * Approves a walk-in and seats them. When every table is full a new table
 * opens; in a captain conclave the admin must pass `captainUid` for it (the
 * walk-in or anyone not already captaining) — otherwise this answers 409 with
 * `needsCaptain` so the panel can ask.
 */
export async function approveWalkIn(
  conclaveId: string,
  uid: string,
  opts: { captainUid?: string | null },
  actor: { uid: string; email?: string },
) {
  const notices: Array<{ uid: string; title: string; body: string; data: Record<string, string> }> = [];

  const result = await pgdb.transaction(async (tx) => {
    const [c] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("update");
    if (!c) throw ApiError.notFound("Conclave not found.");
    if (c.status !== ConclaveStatus.running) throw ApiError.conflict("Walk-ins can be seated only while the conclave is running.");
    const [reg] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)))
      .for("update");
    if (!reg || !reg.isWalkIn) throw ApiError.notFound("No walk-in request from this member.");
    if (reg.walkInStatus === "approved") return { joinsFromRound: reg.joinsFromRound, tableNumber: reg.tableNumber, tablesAdded: [] as number[] };
    if (reg.walkInStatus === "rejected") throw ApiError.conflict("This request was rejected.");

    const fromRound = joinsFromRound(c);
    if (fromRound === null) throw ApiError.conflict("The last round has started, so there's no round left to join.");
    const schedule = c.schedule as unknown as Schedule | null;
    if (!schedule?.rounds?.length) throw ApiError.conflict("This conclave has no tables yet.");

    const participants = (Array.isArray(c.participants) ? c.participants : []) as ServerParticipant[];
    if (participants.some((p) => p._originalUid === uid)) throw ApiError.conflict("This member is already seated.");
    const users = await fetchUsers([uid]);
    const u = users.get(uid);
    if (!u) throw ApiError.notFound("The member's profile wasn't found.");
    const newcomer = {
      id: Math.max(0, ...participants.map((p) => p.id)) + 1,
      name: u.name ?? "",
      phone: u.phone ?? "",
      businessName: u.company ?? "",
      businessCategory: u.category || "Uncategorized",
      location: (u.location ?? { withinGuntur: true }) as never,
      chapter: u.chapter ?? null,
      membership: u.membership ?? "",
      photoUrl: u.photoUrl ?? null,
      _originalUid: uid,
    } as ServerParticipant;

    const everyone = [...participants, newcomer];
    const captainUid = opts.captainUid ? String(opts.captainUid) : null;
    const captainPid = captainUid ? everyone.find((p) => p._originalUid === captainUid)?.id : undefined;
    if (captainUid && captainPid === undefined) throw ApiError.badRequest("The chosen captain isn't part of this conclave.");

    let plan;
    try {
      plan = planWithWalkIns({
        schedule,
        participants,
        newcomers: [newcomer],
        personsPerTable: Number(c.personsPerTable) || schedule.config.personsPerTable,
        roundCount: Number(c.roundCount) || schedule.rounds.length,
        seed: (typeof c.seed === "number" ? c.seed : schedule.config.seed) + fromRound * 7919,
        captainless: c.captainMode === "none",
        fromRound,
        newTableCaptainIds: captainPid !== undefined ? [captainPid] : [],
      });
    } catch (e) {
      if (e instanceof WalkInPlanError) {
        throw ApiError.conflict(e.message, { ...e.details, needsCaptain: Boolean(e.details.needsCaptains) });
      }
      if ((e as Error).name === "InfeasibleRoundError") {
        throw ApiError.conflict("There's no seat for this member in the remaining rounds that keeps this conclave's seating rules.", { detail: (e as Error).message });
      }
      throw e;
    }

    const tableOf = (pid: number) =>
      plan.schedule.rounds
        .find((r) => r.roundNumber === fromRound)
        ?.tables.find((t) => t.captainId === pid || t.memberIds.includes(pid))?.tableNumber ?? null;

    await tx
      .update(conclaves)
      .set({
        schedule: plan.schedule as unknown as Record<string, unknown>,
        participants: plan.participants,
        scheduleSummary: { tableCount: plan.schedule.tableCount, coverage: plan.schedule.stats.coverage, repeatPairings: plan.schedule.stats.repeatPairings },
        updatedAt: new Date(),
      })
      .where(eq(conclaves.id, conclaveId));

    const fee = registrationFeeOf(c);
    const [after] = await tx
      .update(registrations)
      .set({
        walkInStatus: "approved",
        status: "confirmed",
        joinsFromRound: fromRound,
        participantId: newcomer.id,
        role: captainUid === uid ? "captain" : "member",
        tableNumber: tableOf(newcomer.id),
        ...(fee > 0
          ? {
              paymentStatus: "paid",
              amountPaid: fee,
              payment: { method: "offline", status: "paid", amount: fee, currency: "INR", collectedBy: actor.email ?? actor.uid, paidAt: new Date().toISOString() },
            }
          : {}),
        addedBy: { uid: actor.uid, email: actor.email ?? null, via: "walk_in_approval" },
      })
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)))
      .returning();

    // An existing member promoted to captain a new table.
    if (captainUid && captainUid !== uid) {
      await tx
        .update(registrations)
        .set({ role: "captain", tableNumber: plan.tablesAdded[0] ?? null })
        .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, captainUid)));
    }

    await audit.change(
      {
        action: "walk_in.approve",
        entityType: "registration",
        entityId: `${conclaveId}:${uid}`,
        conclaveId,
        before: reg,
        after,
        metadata: { fromRound, tablesAdded: plan.tablesAdded, moved: plan.moved.size, captainUid },
      },
      tx,
    );
    await notifyConclaveChanged(tx, conclaveId);

    const myTable = tableOf(newcomer.id);
    notices.push({
      uid,
      title: "You're in",
      body: `You join from round ${fromRound}${myTable ? ` at Table ${myTable}` : ""}. Head there when it starts.`,
      data: { conclaveId, type: "walk_in_approved", roundNumber: String(fromRound), tableNumber: String(myTable ?? "") },
    });
    for (const [movedUid, table] of plan.moved) {
      if (movedUid === uid) continue;
      notices.push({
        uid: movedUid,
        title: `Round ${fromRound}: Table ${table}`,
        body: `Seating was updated for late arrivals. In round ${fromRound} you sit at Table ${table}.`,
        data: { conclaveId, type: "table_changed", roundNumber: String(fromRound), tableNumber: String(table) },
      });
    }
    return { joinsFromRound: fromRound, tableNumber: myTable, tablesAdded: plan.tablesAdded };
  });

  for (const n of notices) void notifyUser(n.uid, n, "round_alerts").catch(() => {});
  return result;
}

/** Rejects a walk-in request: the registration is removed (audited). */
export async function rejectWalkIn(conclaveId: string, uid: string, reason?: string) {
  await pgdb.transaction(async (tx) => {
    const [reg] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)))
      .for("update");
    if (!reg || !reg.isWalkIn) throw ApiError.notFound("No walk-in request from this member.");
    if (reg.walkInStatus === "approved") throw ApiError.conflict("This walk-in is already seated.");
    await tx.delete(registrations).where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
    await audit.change(
      { action: "walk_in.reject", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, before: reg, metadata: { reason: opt(reason, 300) } },
      tx,
    );
    await notifyConclaveChanged(tx, conclaveId);
  });
  void notifyUser(
    uid,
    {
      title: "Walk-in not approved",
      body: reason ? `Your request to join wasn't approved: ${opt(reason, 300)}` : "Your request to join wasn't approved. Please speak to the organisers.",
      data: { conclaveId, type: "walk_in_rejected" },
    },
    "general",
  ).catch(() => {});
  return { ok: true };
}
