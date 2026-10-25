import { and, eq, inArray } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { attendance, referrals } from "../db/schema.js";
import { env } from "../config/env.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { ScheduleIndex, type StoredSchedule, type StoredParticipant } from "../domain/scheduleIndex.js";
import { getConclaveOrThrow, evaluateConclaveStatus, roundDurationMs, toView, type ConclaveRow } from "./conclave.service.js";
import { fetchUsers } from "./user.service.js";
import { notifyUser, recordUserNotification } from "./notification.service.js";
import { getNotificationTemplates, fillTemplate, getRoundTiming, type RoundTiming } from "./settings.service.js";

/**
 * Offline sync: the phone uploads attendance marks and referrals captured with
 * no connectivity, and gets back the live conclave state for its member.
 *
 * Design rules (see OFFLINE_ATTENDANCE_AND_SYNC.md — "must not be lost"):
 * - Everything from the phone is UNTRUSTED and validated against the schedule.
 * - A captain's mark beats a member's self-mark, whatever order they sync in.
 * - Referrals for the round in progress are judged by WHEN THEY WERE MADE
 *   (the phone's timestamp) against that round's exact window; referrals for
 *   earlier rounds that sync late (venue network back) are accepted, never
 *   lost; future rounds are refused. Referrals are immutable once given.
 * - Each batch is one transaction, audited as a summary; each new referral is
 *   audited individually.
 */

/** A row as the phone's sqflite stores it. */
interface AttendanceRow {
  id?: string;
  userId?: string;
  roundNumber?: number;
  tableNumber?: number;
  isPresent?: number | boolean;
  markedBy?: string;
  timestamp?: string;
}
interface ReferralRow {
  id?: string;
  roundNumber?: number;
  fromUserId?: string;
  fromName?: string;
  toUserId?: string;
  toName?: string;
  notes?: string;
  timestamp?: string;
  status?: string;
}
export interface SyncPayload {
  attendance?: AttendanceRow[];
  referrals?: ReferralRow[];
}

type Mark = { isPresent: boolean; at: string | null; by: string };

/** Clock tolerance for phone timestamps (phones correct with the server offset, but not perfectly). */
const CLOCK_SLACK_MS = 2 * 60_000;
const REFERRAL_STATUSES = new Set(["Pending", "Accepted", "Completed", "Declined"]);

/**
 * When referrals could be given in round `n`: the round's ACTIVE phase, exactly
 * as the app shows it — each person's turn (bio, then their referral time),
 * table by table — and closed at the transition ("Talking time is over…").
 * Same numbers as the app: admin-tuned bio/referral seconds × the conclave's
 * persons-per-table. (An earlier rule opened referrals only after ALL bios,
 * which disagreed with the app and silently dropped referrals given during
 * earlier turns.)
 */
export function referralWindow(
  row: Pick<ConclaveRow, "currentRound" | "currentRoundStartedAt" | "personsPerTable" | "legacy">,
  timing: RoundTiming,
  roundNumber: number,
): { opens: number; closes: number } | null {
  if (!row.currentRoundStartedAt || !row.currentRound) return null;
  const roundMs = roundDurationMs(row.personsPerTable, timing, row.legacy?.roundBlockMinutes);
  const opens = row.currentRoundStartedAt.getTime() + (roundNumber - row.currentRound) * roundMs;
  const p = Math.max(1, row.personsPerTable ?? 1);
  const closes = opens + (timing.bioSeconds + timing.referralSeconds) * 1000 * p;
  return { opens, closes };
}


export async function syncConclave(conclaveId: string, callerUid: string, payload: SyncPayload) {
  const serverReceivedAt = Date.now();
  const insecure = env.allowInsecureAdmin;
  const timing = await getRoundTiming();

  const attendanceRows = Array.isArray(payload?.attendance) ? payload.attendance : [];
  const referralRows = Array.isArray(payload?.referrals) ? payload.referrals : [];
  const errors: string[] = [];
  const acceptedAttendance: string[] = [];
  const acceptedReferrals: string[] = [];
  const newReferralPings: { id: string; toUserId: string; fromUserId: string }[] = [];

  const { row: conclave } = await getConclaveOrThrow(conclaveId);
  const schedule = (conclave.schedule ?? null) as StoredSchedule | null;
  const participants = (Array.isArray(conclave.participants) ? conclave.participants : []) as StoredParticipant[];
  const index = schedule && participants.length ? new ScheduleIndex(schedule, participants) : null;

  // ---- Validate attendance ------------------------------------------------
  const validAttendance: AttendanceRow[] = [];
  for (const a of attendanceRows) {
    const id = a?.id ? String(a.id) : "";
    // Acknowledge rejected rows too, so the phone stops retrying a row that can never succeed.
    const reject = (why: string) => {
      errors.push(`Rejected attendance ${id || "(no id)"}: ${why}`);
      if (id) acceptedAttendance.push(id);
    };
    if (!id || !a.userId || a.roundNumber === undefined) { reject("malformed record."); continue; }
    if (!insecure && a.markedBy !== callerUid) { reject("you can only submit marks you made."); continue; }
    if (!insecure && !index) { reject("this conclave has no schedule."); continue; }
    if (!insecure && index && !index.canMarkAttendance(Number(a.roundNumber), callerUid, String(a.userId))) {
      reject(`you may only mark yourself, or a member of the table you captain in round ${a.roundNumber}.`);
      continue;
    }
    validAttendance.push(a);
  }

  // ---- Validate referrals -------------------------------------------------
  const validReferrals: ReferralRow[] = [];
  for (const r of referralRows) {
    const id = r?.id ? String(r.id) : "";
    const reject = (why: string) => {
      errors.push(`Rejected referral ${id || "(no id)"}: ${why}`);
      if (id) acceptedReferrals.push(id);
    };
    if (!id || !r.fromUserId || !r.toUserId || r.roundNumber === undefined) { reject("malformed record."); continue; }
    const round = Number(r.roundNumber);
    const from = String(r.fromUserId);
    const to = String(r.toUserId);
    if (!insecure && callerUid !== from && callerUid !== to) { reject("you can only send referrals you gave or received."); continue; }
    if (!insecure && index && !index.canRefer(round, from, to)) {
      reject(`a referral is made face to face — you and this member didn't share a table in round ${round}.`);
      continue;
    }
    validReferrals.push(r);
  }

  // ---- Write (one transaction) ---------------------------------------------
  await pgdb.transaction(async (tx) => {
    // Attendance: merge with what's stored so a late self-mark can't clobber a captain's.
    if (validAttendance.length) {
      const ids = validAttendance.map((a) => String(a.id));
      const existing = new Map(
        (await tx.select().from(attendance).where(and(eq(attendance.conclaveId, conclaveId), inArray(attendance.id, ids))).for("update")).map((r) => [r.id, r]),
      );
      let captainMarks = 0;
      for (const a of validAttendance) {
        const id = String(a.id);
        const userId = String(a.userId);
        const isPresent = a.isPresent === 1 || a.isPresent === true;
        const isSelf = callerUid === userId;
        const prior = existing.get(id);
        const mark: Mark = { isPresent, at: a.timestamp ?? null, by: callerUid };
        const captainMark = (isSelf ? prior?.captainMark : mark) ?? null;
        const selfMark = (isSelf ? mark : prior?.selfMark) ?? null;
        const winner = (captainMark ?? selfMark) as Mark;
        if (!isSelf) captainMarks++;
        const values = {
          conclaveId,
          userId,
          roundNumber: Number(a.roundNumber),
          tableNumber: a.tableNumber !== undefined ? Number(a.tableNumber) : null,
          captainMark,
          selfMark,
          isPresent: winner.isPresent,
          source: captainMark ? "captain" : "self",
          markedBy: winner.by,
          markedAt: winner.at ? new Date(winner.at) : null,
          syncedAt: new Date(),
        };
        if (values.markedAt && Number.isNaN(values.markedAt.getTime())) values.markedAt = null;
        await tx.insert(attendance).values({ id, ...values }).onConflictDoUpdate({ target: attendance.id, set: values });
        acceptedAttendance.push(id);
      }
      // One summary row per batch; the per-mark who/when lives on the attendance row itself.
      await audit.change(
        {
          action: "attendance.sync",
          entityType: "attendance",
          conclaveId,
          metadata: { marks: validAttendance.length, captainMarks, selfMarks: validAttendance.length - captainMarks, ids: validAttendance.slice(0, 50).map((a) => a.id) },
        },
        tx,
      );
    }

    // Referrals: new ones are created by the giver within that round's window;
    // existing ones are immutable except their status.
    for (const r of validReferrals) {
      const id = String(r.id);
      const round = Number(r.roundNumber);
      const [prior] = await tx.select().from(referrals).where(eq(referrals.id, id)).for("update");

      if (!prior) {
        if (!insecure && callerUid !== String(r.fromUserId)) {
          errors.push(`Rejected referral ${id}: only the member giving a referral can create it.`);
          acceptedReferrals.push(id);
          continue;
        }
        // Only the round in progress has an EXACT window (its anchor is known);
        // judge it by when the referral was MADE (phone time). Earlier rounds'
        // windows can only be estimated (rounds may have been closed early), so
        // a late sync for a past round is accepted rather than risk losing it.
        const madeAt = r.timestamp ? Date.parse(r.timestamp) : NaN;
        const liveRound = conclave.currentRound || 0;
        if (!insecure && liveRound && round > liveRound) {
          errors.push(`Rejected referral ${id}: round ${round} hasn't started yet.`);
          acceptedReferrals.push(id);
          continue;
        }
        if (!insecure && round === liveRound && Number.isFinite(madeAt)) {
          const w = referralWindow(conclave, timing, round);
          if (w && madeAt < w.opens - CLOCK_SLACK_MS) {
            errors.push(`Rejected referral ${id}: it was made before round ${round} started.`);
            acceptedReferrals.push(id);
            continue;
          }
          if (w && madeAt > w.closes + CLOCK_SLACK_MS) {
            errors.push(`Rejected referral ${id}: it was made after round ${round}'s talking time ended.`);
            acceptedReferrals.push(id);
            continue;
          }
        }
        const createdAt = Number.isFinite(madeAt) ? new Date(madeAt) : null;
        const [created] = await tx
          .insert(referrals)
          .values({
            id,
            conclaveId,
            fromUserId: String(r.fromUserId),
            toUserId: String(r.toUserId),
            fromName: r.fromName ? String(r.fromName).slice(0, 200) : null,
            toName: r.toName ? String(r.toName).slice(0, 200) : null,
            roundNumber: round,
            notes: String(r.notes ?? "").slice(0, 2000),
            status: REFERRAL_STATUSES.has(String(r.status)) ? String(r.status) : "Pending",
            createdAt,
          })
          .returning();
        await audit.change({ action: "referral.create", entityType: "referral", entityId: id, conclaveId, after: created }, tx);
        if (created.toUserId !== created.fromUserId) newReferralPings.push({ id, toUserId: created.toUserId, fromUserId: created.fromUserId });
      } else {
        if (prior.conclaveId !== conclaveId) {
          errors.push(`Rejected referral ${id}: it belongs to a different conclave.`);
        } else if (r.status && REFERRAL_STATUSES.has(String(r.status)) && r.status !== prior.status) {
          const [after] = await tx.update(referrals).set({ status: String(r.status), syncedAt: new Date() }).where(eq(referrals.id, id)).returning();
          await audit.change({ action: "referral.status", entityType: "referral", entityId: id, conclaveId, before: prior, after }, tx);
        }
      }
      acceptedReferrals.push(id);
    }
  });

  // ---- Tell recipients a referral landed (best-effort, after commit) --------
  if (newReferralPings.length) {
    const givers = await fetchUsers(newReferralPings.map((p) => p.fromUserId));
    const tpl = (await getNotificationTemplates()).referralReceived;
    for (const p of newReferralPings) {
      const giver = givers.get(p.fromUserId)?.name || "A member";
      const msg = {
        title: fillTemplate(tpl.title, { giver }),
        body: fillTemplate(tpl.body, { giver }),
        data: { type: "referral_received", conclaveId, id: p.id },
      };
      void notifyUser(p.toUserId, msg, "referrals");
      void recordUserNotification(p.toUserId, { ...msg, type: "referral_received" });
    }
  }

  return buildState(conclave, conclaveId, callerUid, { serverReceivedAt, acceptedAttendance, acceptedReferrals, errors, timing });
}

// ---------------------------------------------------------------------------
// The state the phone gets back
// ---------------------------------------------------------------------------

function formatTime12h(date: Date) {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

async function buildState(
  conclave: ConclaveRow,
  conclaveId: string,
  callerUid: string,
  ctx: { serverReceivedAt: number; acceptedAttendance: string[]; acceptedReferrals: string[]; errors: string[]; timing: RoundTiming },
) {
  const view = toView(conclave);
  const participants = (Array.isArray(conclave.participants) ? conclave.participants : []) as any[];
  const schedule = conclave.schedule as any;
  const getUid = (p: any) => p?._originalUid || p?.uid || p?.userId || String(p?.id);
  const isLive = conclave.status === "running" || conclave.status === "active";
  const roundMs = roundDurationMs(conclave.personsPerTable, ctx.timing, conclave.legacy?.roundBlockMinutes);

  // Referrals given TO this member.
  const received = await pgdb.select().from(referrals).where(and(eq(referrals.conclaveId, conclaveId), eq(referrals.toUserId, callerUid)));
  const givers = await fetchUsers(received.map((r) => r.fromUserId));
  const newReferralsReceived = received.map((r) => ({
    id: r.id,
    conclaveId,
    roundNumber: r.roundNumber,
    fromUserId: r.fromUserId,
    toUserId: r.toUserId,
    fromName: givers.get(r.fromUserId)?.name ?? r.fromName ?? "",
    fromBusinessName: givers.get(r.fromUserId)?.company ?? "",
    notes: r.notes,
    status: r.status || "Pending",
    createdAt: r.createdAt?.toISOString() ?? null,
  }));

  // A round's time label: the live anchor while running, else the planned start.
  const roundTimeLabel = (n: number) => {
    let base = conclave.startDate ? new Date(conclave.startDate) : new Date();
    const [hh, mm] = String(conclave.startTime ?? "").split(":");
    if (hh && mm) base.setHours(Number(hh) || 9, Number(mm) || 0, 0, 0);
    if (isLive && conclave.currentRoundStartedAt && conclave.currentRound) {
      base = new Date(conclave.currentRoundStartedAt.getTime() - (conclave.currentRound - 1) * roundMs);
    }
    const start = new Date(base.getTime() + (n - 1) * roundMs);
    return `${formatTime12h(start)} - ${formatTime12h(new Date(start.getTime() + roundMs))}`;
  };

  let tableNumber: number | null = null;
  let captainName = "";
  let tableOccupants: any[] = [];
  let mySchedule: any[] = [];

  const me = participants.find((p) => getUid(p) === callerUid);
  if (me && schedule?.rounds) {
    const presence = new Map<string, boolean>();
    for (const a of await pgdb.select().from(attendance).where(eq(attendance.conclaveId, conclaveId))) {
      presence.set(`${a.roundNumber}-${a.userId}`, a.isPresent);
    }
    const current = conclave.currentRound || 1;
    const person = (p: any, isCaptain: boolean, round: number) => ({
      uid: getUid(p),
      name: p.name,
      company: p.businessName || p.company || "Member",
      category: p.businessCategory || p.category || "BNI Member",
      chapter: p.chapter || "BNI",
      isCaptain,
      isPresent: presence.get(`${round}-${getUid(p)}`) ?? isCaptain,
    });

    mySchedule = schedule.rounds
      .map((r: any) => {
        const table = r.tables?.find((t: any) => t.captainId === me.id || t.memberIds?.includes(me.id));
        if (!table) return null;
        const n = r.roundNumber;
        const status = n < current ? "Completed" : n === current && isLive ? "Active" : "Upcoming";
        const cap = participants.find((p) => p.id === table.captainId);
        const mates = participants.filter((p) => table.memberIds?.includes(p.id));
        return {
          number: n,
          status,
          table: `Table ${table.tableNumber}`,
          tableNumber: table.tableNumber,
          captain: cap ? cap.name : "Unknown",
          time: roundTimeLabel(n),
          participants: [...(cap ? [person(cap, true, n)] : []), ...mates.map((m) => person(m, false, n))],
        };
      })
      .filter(Boolean);

    const seat = mySchedule.find((s) => s.number === current) ?? mySchedule[0];
    if (seat) {
      tableNumber = seat.tableNumber;
      captainName = seat.captain;
      tableOccupants = seat.participants;
    }
  }

  const status = conclave.status === "completed" || conclave.status === "cancelled" ? conclave.status : evaluateConclaveStatus(view).status;
  const conclaveStatus = {
    id: conclaveId,
    name: conclave.name,
    status,
    currentRound: conclave.currentRound,
    currentRoundStartedAt: view.currentRoundStartedAt,
    isRoundPaused: conclave.isRoundPaused,
    roundPausedAt: view.roundPausedAt,
    serverSentAt: new Date().toISOString(),
    title: conclave.name,
    date: view.date,
    venue: conclave.venueLocation || "TBD Venue",
    region: conclave.region ?? "",
    startTime: conclave.startTime,
    endTime: conclave.endTime,
    agendaDocument: conclave.agendaDocument ?? null,
  };

  return {
    serverReceivedAt: new Date(ctx.serverReceivedAt).toISOString(),
    serverSentAt: new Date().toISOString(),
    syncedAttendanceIds: [...new Set(ctx.acceptedAttendance)],
    syncedReferralIds: [...new Set(ctx.acceptedReferrals)],
    newReferralsReceived,
    conclaveStatus,
    agendaDocument: conclave.agendaDocument ?? null,
    tableNumber,
    captainName,
    tableOccupants,
    mySchedule,
    errors: ctx.errors,
  };
}

export function requireSchedule(conclave: { schedule?: unknown }) {
  if (!conclave.schedule) throw ApiError.badRequest("No schedule has been generated.");
}
