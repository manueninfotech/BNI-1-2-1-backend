import { db, collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { ScheduleIndex } from "../domain/scheduleIndex.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";
import { fetchUsers } from "./user.service.js";
import { notifyUser } from "./notification.service.js";
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
      void notifyUser(
        p.toUserId,
        {
          title: "New referral 🎉",
          body: `${giverName} just passed you a referral.`,
          data: { type: "referral_received", conclaveId, id: p.id },
        },
        "referrals",
      );
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

  const getRoundTimeLabel = (roundNum: number) => {
    const times = [
      "09:00 AM - 09:45 AM",
      "10:15 AM - 11:00 AM",
      "11:30 AM - 12:15 PM",
      "01:30 PM - 02:15 PM",
      "02:45 PM - 03:30 PM",
      "04:00 PM - 04:45 PM",
      "05:15 PM - 06:00 PM",
      "06:30 PM - 07:15 PM"
    ];
    return times[roundNum - 1] || "TBD Time";
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
      status: conclave.status ?? "draft",
      currentRound: conclave.currentRound ?? 0,
      currentRoundStartedAt: toIso(conclave.currentRoundStartedAt),
      serverSentAt: new Date().toISOString(),
      title: conclave.name || conclave.title || "BNI Conclave",
      date: conclave.date || null,
      venue: conclave.venueLocation || conclave.venue || "TBD Venue",
      region: conclave.region || "Vijayawada Region"
    },
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
