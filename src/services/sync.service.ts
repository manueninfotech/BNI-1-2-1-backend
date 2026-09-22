import { db, collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { ScheduleIndex } from "../domain/scheduleIndex.js";
import { getConclaveOrThrow, conclaveRef, evaluateConclaveStatus, clearConclaveCache } from "./conclave.service.js";
import { fetchUsers } from "./user.service.js";
import { notifyUser, recordUserNotification } from "./notification.service.js";
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
  fromName?: string;
  toUserId?: string;
  toName?: string;
  notes?: string;
  timestamp?: string;
  status?: string;
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
    id?: string;
    name?: string;
    status: string;
    currentRound: number;
    currentRoundStartedAt: string | null;
    title: string;
    date: string | null;
    venue: string;
    region?: string;
    startTime?: string | null;
    endTime?: string | null;
  };
  tableNumber: number | null;
  captainName: string | null;
  tableOccupants: Array<{
    uid: string;
    name: string;
    company: string;
    category: string;
    chapter: string;
    isCaptain: boolean;
    isPresent: boolean;
  }>;
  mySchedule: Array<{
    number: number;
    status: string;
    table: string;
    tableNumber: number;
    captain: string;
    time: string;
    participants: Array<{
      uid: string;
      name: string;
      company: string;
      category: string;
      chapter: string;
      isCaptain: boolean;
      isPresent: boolean;
    }>;
  }>;
  errors: string[];
}

export interface SyncPayload {
  attendance?: AttendanceRow[];
  referrals?: ReferralRow[];
}

export async function syncConclave(
  conclaveId: string,
  callerUid: string,
  payload: SyncPayload,
) {
  const serverReceivedAt = Date.now();
  // Always clear cache before sync so evaluateConclaveStatus uses fresh Firestore data.
  // This ensures endTime-based completion is detected on every sync poll.
  clearConclaveCache();
  const { data: conclave } = await getConclaveOrThrow(conclaveId);
  const ref = conclaveRef(conclaveId);

  const attendanceRows = Array.isArray(payload.attendance) ? payload.attendance : [];
  const referralRows = Array.isArray(payload.referrals) ? payload.referrals : [];

  const errors: string[] = [];
  const acceptedAttendance: string[] = [];
  const acceptedReferrals: string[] = [];
  // Candidate referral-received pings; deduped to newly-created ones before send.
  const referralPings: { id: string; toUserId: string; fromUserId: string }[] = [];

  const index =
    conclave.schedule && Array.isArray(conclave.participants)
      ? new ScheduleIndex(conclave.schedule, conclave.participants)
      : null;

  const batch = db.batch();

  // ---- Attendance --------------------------------------------------------
  const valid: AttendanceRow[] = [];
  for (const a of attendanceRows) {
    const id = a?.id;
    if (!id || !a.userId || a.roundNumber === undefined) {
      errors.push(`Malformed attendance record ignored: ${JSON.stringify(a)}`);
      if (id) acceptedAttendance.push(id);
      continue;
    }

    if (!env.allowInsecureAdmin && a.markedBy !== callerUid) {
      errors.push(`Rejected attendance ${id}: you can only submit marks you made.`);
      acceptedAttendance.push(id);
      continue;
    }

    if (!env.allowInsecureAdmin && !index) {
      errors.push(`Rejected attendance ${id}: this conclave has no schedule.`);
      acceptedAttendance.push(id);
      continue;
    }

    if (!env.allowInsecureAdmin && index && !index.canMarkAttendance(Number(a.roundNumber), callerUid, a.userId)) {
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

    const isGiverOrReceiver = callerUid === r.fromUserId || callerUid === r.toUserId;
    if (!env.allowInsecureAdmin && !isGiverOrReceiver) {
      errors.push(`Rejected referral ${id}: you can only update referrals you gave or received.`);
      acceptedReferrals.push(id);
      continue;
    }

    if (!r.toUserId) {
      errors.push(`Rejected referral ${id}: recipient user ID is required.`);
      acceptedReferrals.push(id);
      continue;
    }

    // Enforce: Referral sending is closed after talking time for the round
    const currentRoundNum = conclave.currentRound ?? 1;
    const refRound = Number(r.roundNumber);

    if (refRound < currentRoundNum) {
      errors.push(`Rejected referral ${id}: Round ${refRound} has already ended. Referrals are closed.`);
      acceptedReferrals.push(id);
      continue;
    }

    if (refRound === currentRoundNum && conclave.currentRoundStartedAt) {
      let startedMs: number | null = null;
      const rawStart = conclave.currentRoundStartedAt as any;
      if (typeof rawStart === 'object' && rawStart !== null) {
        if (typeof rawStart._seconds === 'number') startedMs = rawStart._seconds * 1000;
        else if (typeof rawStart.seconds === 'number') startedMs = rawStart.seconds * 1000;
        else if (typeof rawStart.toDate === 'function') startedMs = rawStart.toDate().getTime();
      } else if (typeof rawStart === 'string' || typeof rawStart === 'number') {
        const d = new Date(rawStart).getTime();
        if (!isNaN(d)) startedMs = d;
      }

      if (startedMs) {
        const elapsedSecs = Math.max(0, Math.floor((serverReceivedAt - startedMs) / 1000));
        let p = Math.max(1, Number(conclave.personsPerTable) || 6);
        if (conclave.schedule?.rounds) {
          const currentRoundObj = conclave.schedule.rounds.find((rnd: any) => rnd.roundNumber === currentRoundNum);
          if (currentRoundObj?.tables) {
            const userTable = currentRoundObj.tables.find((tbl: any) =>
              tbl.captainId === r.fromUserId || tbl.memberIds?.includes(r.fromUserId)
            );
            if (userTable) {
              const count = (userTable.memberIds?.length || 0) + (userTable.captainId ? 1 : 0);
              if (count > 0) p = count;
            }
          }
        }
        const talkingSecs = Math.min(15 * 60, p * 60); // 1 min per person talking
        const referralSecs = Math.min(15 * 60 - talkingSecs, p * 30); // 30s per person referral
        const referralEndSecs = talkingSecs + referralSecs;

        if (elapsedSecs < talkingSecs) {
          errors.push(`Rejected referral ${id}: Round ${currentRoundNum} is currently in talking time. Referrals open only during the referral window.`);
          acceptedReferrals.push(id);
          continue;
        }

        if (elapsedSecs >= referralEndSecs) {
          errors.push(`Rejected referral ${id}: Referral window for Round ${currentRoundNum} has ended. Table rotation is in progress.`);
          acceptedReferrals.push(id);
          continue;
        }
      }
    }

    batch.set(
      ref.collection(collections.referrals).doc(String(id)),
      {
        fromUserId: String(r.fromUserId),
        toUserId: String(r.toUserId),
        ...(r.fromName ? { fromName: r.fromName } : {}),
        ...(r.toName ? { toName: r.toName } : {}),
        roundNumber: Number(r.roundNumber),
        notes: r.notes ?? "",
        status: r.status || "Pending",
        createdAt: r.timestamp ?? null,
        syncedAt: new Date(),
      },
      { merge: true },
    );
    acceptedReferrals.push(String(id));
    if (String(r.toUserId) !== String(r.fromUserId)) {
      referralPings.push({
        id: String(id),
        toUserId: String(r.toUserId),
        fromUserId: String(r.fromUserId),
      });
    }
  }

  // Which of those referrals are NEW? Read pre-commit state so a re-sync of the
  // same referral doesn't ping the recipient twice.
  let newReferralPings: typeof referralPings = [];
  if (referralPings.length) {
    const snaps = await db.getAll(
      ...referralPings.map((p) =>
        ref.collection(collections.referrals).doc(p.id),
      ),
    );
    newReferralPings = referralPings.filter((_, i) => !snaps[i].exists);
  }

  await batch.commit();

  // Tell each recipient a referral just landed. Best-effort; never fails a sync.
  if (newReferralPings.length) {
    const giverIds = [...new Set(newReferralPings.map((p) => p.fromUserId))];
    const givers = await fetchUsers(giverIds);
    for (const p of newReferralPings) {
      const giverName = (givers.get(p.fromUserId) as any)?.name || "A member";
      const msg = {
        title: "New referral 🎉",
        body: `${giverName} just passed you a referral.`,
        data: { type: "referral_received", conclaveId, id: p.id },
      };
      void notifyUser(p.toUserId, msg, "referrals");
      void recordUserNotification(p.toUserId, {
        ...msg,
        type: "referral_received",
      });
    }
  }

  const participants = Array.isArray(conclave.participants) ? conclave.participants : [];
  const schedule = conclave.schedule;

  const getUid = (p: any) => p?._originalUid || p?.uid || p?.userId || p?.id || String(p?.id);

  const callerParticipant = participants.find((p: any) => 
    p._originalUid === callerUid || 
    p.uid === callerUid || 
    p.userId === callerUid || 
    p.id === callerUid ||
    String(p.id) === String(callerUid)
  );

  // ---- Referrals given TO this user -------------------------------------
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
      status: r.status || "Pending",
      createdAt: r.createdAt ?? null,
    };
  });

  let tableNumber: number | null = null;
  let captainName = "";
  let tableOccupants: any[] = [];
  let mySchedule: any[] = [];

  const formatTime12h = (date: Date) => {
    let h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    h = h ? h : 12;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  const getRoundTimeLabel = (roundNum: number) => {
    const ROUND_DURATION_MS = 15 * 60 * 1000; // Each round is 15 minutes
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const now = new Date();

    // 1. Determine base start datetime for Round 1
    let baseStartDate: Date;
    if (conclave.startTime && typeof conclave.startTime === "string") {
      const [hStr, mStr] = conclave.startTime.split(":");
      baseStartDate = new Date(
        conclave.date
          ? typeof conclave.date.toDate === "function"
            ? conclave.date.toDate()
            : new Date(conclave.date)
          : new Date()
      );
      if (hStr && mStr) {
        baseStartDate.setHours(parseInt(hStr, 10) || 9, parseInt(mStr, 10) || 0, 0, 0);
      }
    } else if (conclave.date) {
      baseStartDate =
        typeof conclave.date.toDate === "function"
          ? conclave.date.toDate()
          : new Date(conclave.date);
    } else {
      baseStartDate = new Date();
      baseStartDate.setHours(9, 0, 0, 0);
    }

    const currentRound = conclave.currentRound || 1;
    const isConclaveLive = conclave.status === "running" || conclave.status === "active";
    const roundStartedAt = conclave.currentRoundStartedAt
      ? typeof conclave.currentRoundStartedAt.toDate === "function"
        ? conclave.currentRoundStartedAt.toDate()
        : new Date(conclave.currentRoundStartedAt)
      : null;

    let start: Date;
    let end: Date;

    if (isConclaveLive && roundStartedAt) {
      if (roundNum === currentRound) {
        // Current active round: started at roundStartedAt, duration 15 mins
        start = new Date(roundStartedAt);
        end = new Date(start.getTime() + ROUND_DURATION_MS);
      } else if (roundNum > currentRound) {
        // Upcoming rounds: sequentially 15 minutes after current round ends
        const currentRoundEndsAt = new Date(roundStartedAt.getTime() + ROUND_DURATION_MS);
        start = new Date(currentRoundEndsAt.getTime() + (roundNum - (currentRound + 1)) * ROUND_DURATION_MS);

        // If scheduled time has passed and round is still not started, increase by 5 mins every time
        if (now.getTime() >= start.getTime()) {
          const elapsedMs = now.getTime() - start.getTime();
          const increments = Math.floor(elapsedMs / FIVE_MIN_MS) + 1;
          start = new Date(start.getTime() + increments * FIVE_MIN_MS);
        }
        end = new Date(start.getTime() + ROUND_DURATION_MS);
      } else {
        // Past round
        start = new Date(baseStartDate.getTime() + (roundNum - 1) * ROUND_DURATION_MS);
        end = new Date(start.getTime() + ROUND_DURATION_MS);
      }
    } else {
      // Conclave or round not started yet:
      // Initial scheduled start differs by 15 mins per round
      start = new Date(baseStartDate.getTime() + (roundNum - 1) * ROUND_DURATION_MS);

      // If scheduled time has passed and round is still not started, increase by 5 mins every time
      if (now.getTime() >= start.getTime()) {
        const elapsedMs = now.getTime() - start.getTime();
        const increments = Math.floor(elapsedMs / FIVE_MIN_MS) + 1;
        start = new Date(start.getTime() + increments * FIVE_MIN_MS);
      }
      end = new Date(start.getTime() + ROUND_DURATION_MS);
    }

    return `${formatTime12h(start)} - ${formatTime12h(end)}`;
  };

  const targetParticipant = callerParticipant || (participants.length > 0 ? participants[0] : null);

  if (targetParticipant && schedule?.rounds) {
    const pId = targetParticipant.id;
    const currentRound = conclave.currentRound || 1;

    const presenceMap = new Map<string, boolean>();
    const attSnap = await ref.collection(collections.attendance).get();
    attSnap.forEach(d => {
      const a = d.data();
      const isP = !!a.isPresent;
      if (a.userId) {
        presenceMap.set(`${a.roundNumber}-${a.userId}`, isP);
        presenceMap.set(`${a.roundNumber}-${String(a.userId)}`, isP);
      }
    });

    mySchedule = schedule.rounds.map((r: any) => {
      const table = r.tables?.find((t: any) => t.captainId === pId || t.memberIds?.includes(pId));
      if (!table) return null;

      const rNum = r.roundNumber;
      let status = "Upcoming";
      if (rNum < currentRound) {
        status = "Completed";
      } else if (rNum === currentRound && (conclave.status === "active" || conclave.status === "running")) {
        status = "Active";
      }

      const capObj = participants.find((p: any) => p.id === table.captainId);
      const memObjs = participants.filter((p: any) => table.memberIds?.includes(p.id));
      const occupantsList = [
        ...(capObj ? [{
          uid: getUid(capObj),
          name: capObj.name,
          company: capObj.businessName || capObj.company || capObj.businessCategory || "Member",
          category: capObj.businessCategory || capObj.category || "BNI Member",
          chapter: capObj.chapter || "BNI",
          isCaptain: true,
          isPresent: presenceMap.get(`${rNum}-${getUid(capObj)}`) ?? presenceMap.get(`${rNum}-${capObj.id}`) ?? presenceMap.get(`${rNum}-${String(capObj.id)}`) ?? true
        }] : []),
        ...memObjs.map((o: any) => ({
          uid: getUid(o),
          name: o.name,
          company: o.businessName || o.company || o.businessCategory || "Member",
          category: o.businessCategory || o.category || "BNI Member",
          chapter: o.chapter || "BNI",
          isCaptain: false,
          isPresent: presenceMap.get(`${rNum}-${getUid(o)}`) ?? presenceMap.get(`${rNum}-${o.id}`) ?? presenceMap.get(`${rNum}-${String(o.id)}`) ?? false
        }))
      ];

      return {
        number: rNum,
        status,
        table: `Table ${table.tableNumber}`,
        tableNumber: table.tableNumber,
        captain: capObj ? capObj.name : "Unknown",
        time: getRoundTimeLabel(rNum),
        participants: occupantsList
      };
    }).filter(Boolean);

    const currentRoundSeating = mySchedule.find(s => s.number === currentRound) || (mySchedule.length > 0 ? mySchedule[0] : null);
    if (currentRoundSeating) {
      tableNumber = currentRoundSeating.tableNumber;
      captainName = currentRoundSeating.captain;
      tableOccupants = currentRoundSeating.participants;
    }
  }

  return {
    serverReceivedAt: new Date(serverReceivedAt).toISOString(),
    serverSentAt: new Date().toISOString(),
    syncedAttendanceIds: acceptedAttendance,
    syncedReferralIds: acceptedReferrals,
    newReferralsReceived,
    conclaveStatus: {
      id: conclaveId,
      name: conclave.name || conclave.title || "BNI Conclave",
      status: (conclave.status === 'completed' || conclave.status === 'cancelled')
        ? conclave.status
        : evaluateConclaveStatus(conclave).status,
      currentRound: conclave.currentRound ?? 0,
      currentRoundStartedAt: toIso(conclave.currentRoundStartedAt),
      serverSentAt: new Date().toISOString(),
      title: conclave.name || conclave.title || "BNI Conclave",
      date: conclave.date ? (typeof conclave.date === 'string' ? conclave.date : toIso(conclave.date)) : null,
      venue: conclave.venueLocation || conclave.venue || "TBD Venue",
      region: conclave.region || "Vijayawada Region",
      startTime: conclave.startTime ? (typeof conclave.startTime === 'string' ? conclave.startTime : toIso(conclave.startTime)) : null,
      endTime: conclave.endTime ? (typeof conclave.endTime === 'string' ? conclave.endTime : toIso(conclave.endTime)) : null,
      agendaDocument: conclave.agendaDocument || null
    },
    agendaDocument: conclave.agendaDocument || null,
    tableNumber,
    captainName,
    tableOccupants,
    mySchedule,
    errors,
  };
}

export function requireSchedule(conclave: Record<string, unknown>) {
  if (!conclave.schedule) throw ApiError.badRequest("No schedule has been generated.");
}
