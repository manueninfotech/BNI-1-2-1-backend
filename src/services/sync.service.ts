import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import { ScheduleIndex } from "../domain/scheduleIndex.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";
import { fetchUsers } from "./user.service.js";
import { getAllDocs, toIso } from "../utils/firestore.js";

/** A row as the phone's sqflite stores it. Everything here is UNTRUSTED. */
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
  toUserId?: string;
  notes?: string;
  timestamp?: string;
}

export interface SyncInput {
  attendance?: unknown;
  referrals?: unknown;
}

export interface SyncResult {
  serverReceivedAt: string;
  serverSentAt: string;
  syncedAttendanceIds: string[];
  syncedReferralIds: string[];
  newReferralsReceived: unknown[];
  conclaveStatus: {
    status: string;
    currentRound: number;
    currentRoundStartedAt: string | null;
  };
  errors: string[];
}

/**
 * Accept offline captures from one phone.
 *
 * SECURITY: `callerUid` comes from a VERIFIED Firebase token, never from the
 * request body. Everything else in the payload is attacker-controlled, and is
 * checked against the schedule before it is written:
 *
 *   - a record may only be attributed to the caller (`markedBy` / `fromUserId`);
 *   - attendance may only be recorded by the person themselves, or by the
 *     captain of the table they actually sat at that round;
 *   - a referral requires that the two people actually shared a table that round.
 *
 * Rejected rows are still ACKNOWLEDGED, so the phone stops retrying them
 * forever, and the reason is returned in `errors`. Silently accepting them would
 * corrupt the event; silently dropping them without acknowledgement would make
 * the phone retry a poisoned record until the battery died.
 */
export async function syncConclave(
  conclaveId: string,
  callerUid: string,
  input: SyncInput,
  serverReceivedAt: number,
): Promise<SyncResult> {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);
  const ref = conclaveRef(conclaveId);

  const attendanceRows: AttendanceRow[] = Array.isArray(input.attendance)
    ? (input.attendance as AttendanceRow[])
    : [];
  const referralRows: ReferralRow[] = Array.isArray(input.referrals)
    ? (input.referrals as ReferralRow[])
    : [];

  const errors: string[] = [];
  const acceptedAttendance: string[] = [];
  const acceptedReferrals: string[] = [];

  // Without a schedule nobody has a table, so nothing can be validated — and
  // nothing should have been captured either.
  const index =
    conclave.schedule && Array.isArray(conclave.participants)
      ? new ScheduleIndex(conclave.schedule, conclave.participants)
      : null;

  const batch = db.batch();

  // ---- Attendance --------------------------------------------------------
  //
  // Both a member and their captain can mark the same person for the same round,
  // on different devices, syncing in an arbitrary order. Storing a single
  // `isPresent` meant whoever synced LAST won — the answer depended on network
  // timing. The marks are stored separately and the truth is derived:
  //
  //     isPresent = captainMark ?? selfMark
  //
  // The captain is believed. The self-mark is the fallback, used when the captain
  // never recorded that person (their phone died, the badge was missed).

  const valid: AttendanceRow[] = [];
  for (const a of attendanceRows) {
    const id = a?.id;
    if (!id || !a.userId || a.roundNumber === undefined) {
      errors.push(`Malformed attendance record ignored: ${JSON.stringify(a)}`);
      if (id) acceptedAttendance.push(id); // don't let it retry forever
      continue;
    }

    if (a.markedBy !== callerUid) {
      // The phone claimed someone else recorded this. Only the caller can vouch
      // for what the caller captured.
      errors.push(`Rejected attendance ${id}: you can only submit marks you made.`);
      acceptedAttendance.push(id);
      continue;
    }

    if (!index) {
      errors.push(`Rejected attendance ${id}: this conclave has no schedule.`);
      acceptedAttendance.push(id);
      continue;
    }

    if (!index.canMarkAttendance(Number(a.roundNumber), callerUid, a.userId)) {
      errors.push(
        `Rejected attendance ${id}: you may only mark yourself, or a member of the table you captain in round ${a.roundNumber}.`,
      );
      acceptedAttendance.push(id);
      continue;
    }

    valid.push(a);
  }

  // Read what's already stored so a late self-mark cannot clobber a captain's.
  const existing = await getAllDocs<Record<string, unknown>>(
    valid.map((a) => ref.collection(collections.attendance).doc(String(a.id))),
  );

  for (const a of valid) {
    const id = String(a.id);
    const userId = String(a.userId);
    // sqflite has no bool type: it round-trips these as 0/1.
    const isPresent = a.isPresent === 1 || a.isPresent === true;
    const isSelfMark = callerUid === userId;

    const prior = existing.get(id) ?? {};
    const mark = { isPresent, at: a.timestamp ?? null, by: callerUid };

    const captainMark = (isSelfMark ? prior.captainMark : mark) ?? null;
    const selfMark = (isSelfMark ? mark : prior.selfMark) ?? null;
    const winner = (captainMark ?? selfMark) as { isPresent: boolean; at: string | null; by: string };

    batch.set(
      ref.collection(collections.attendance).doc(id),
      {
        userId,
        roundNumber: Number(a.roundNumber),
        tableNumber: a.tableNumber !== undefined ? Number(a.tableNumber) : null,
        captainMark,
        selfMark,
        isPresent: winner.isPresent,
        source: captainMark ? "captain" : "self",
        markedBy: winner.by,
        markedAt: winner.at,
        syncedAt: new Date(),
      },
      { merge: true },
    );
    acceptedAttendance.push(id);
  }

  // ---- Referrals ---------------------------------------------------------
  for (const r of referralRows) {
    const id = r?.id;
    if (!id || !r.fromUserId || !r.toUserId || r.roundNumber === undefined) {
      errors.push(`Malformed referral ignored: ${JSON.stringify(r)}`);
      if (id) acceptedReferrals.push(id);
      continue;
    }

    if (r.fromUserId !== callerUid) {
      errors.push(`Rejected referral ${id}: you can only give referrals as yourself.`);
      acceptedReferrals.push(id);
      continue;
    }

    if (!index || !index.canRefer(Number(r.roundNumber), callerUid, r.toUserId)) {
      // A referral is a promise made face to face. If they never shared a table
      // that round, it did not happen.
      errors.push(
        `Rejected referral ${id}: you did not share a table with that person in round ${r.roundNumber}.`,
      );
      acceptedReferrals.push(id);
      continue;
    }

    batch.set(
      ref.collection(collections.referrals).doc(String(id)),
      {
        fromUserId: callerUid,
        toUserId: String(r.toUserId),
        roundNumber: Number(r.roundNumber),
        notes: r.notes ?? "",
        createdAt: r.timestamp ?? null,
        syncedAt: new Date(),
      },
      { merge: true },
    );
    acceptedReferrals.push(String(id));
  }

  // Commit FIRST. The client marks a record synced as soon as its id comes back
  // and never retries it, so an id may only be acknowledged once the write has
  // actually committed. If this throws, the request fails with NO acknowledged
  // ids and the phone keeps its records.
  await batch.commit();

  // ---- Referrals given TO this user -------------------------------------
  //
  // A referral is one fact seen from two sides. It was created on the giver's
  // phone, so the only way it reaches the receiver is back down through here.
  const receivedSnap = await ref
    .collection(collections.referrals)
    .where("toUserId", "==", callerUid)
    .get();

  const giverIds = [...new Set(receivedSnap.docs.map((d) => d.data().fromUserId as string))];
  const givers = await fetchUsers(giverIds);

  const newReferralsReceived = receivedSnap.docs.map((d) => {
    const r = d.data();
    const giver = givers.get(r.fromUserId);
    return {
      id: d.id,
      conclaveId,
      roundNumber: r.roundNumber ?? 0,
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      fromName: giver?.name ?? "",
      fromBusinessName: giver?.businessName ?? "",
      notes: r.notes ?? "",
      createdAt: r.createdAt ?? null,
    };
  });

  return {
    // NTP-style pair. The client needs BOTH: with a single timestamp it cannot
    // tell network latency apart from server processing time, and the Firestore
    // work above routinely takes seconds. Sending both lets the client cancel the
    // processing time out exactly, instead of mistaking half of it for latency
    // and shoving its clock seconds into the future.
    serverReceivedAt: new Date(serverReceivedAt).toISOString(),
    serverSentAt: new Date().toISOString(),
    syncedAttendanceIds: acceptedAttendance,
    syncedReferralIds: acceptedReferrals,
    newReferralsReceived,
    conclaveStatus: {
      status: conclave.status ?? "draft",
      currentRound: conclave.currentRound ?? 0,
      currentRoundStartedAt: toIso(conclave.currentRoundStartedAt),
    },
    errors,
  };
}

export function requireSchedule(conclave: Record<string, unknown>) {
  if (!conclave.schedule) throw ApiError.badRequest("No schedule has been generated.");
}
