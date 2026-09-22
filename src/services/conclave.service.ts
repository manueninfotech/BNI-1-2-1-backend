import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import {
  ConclaveStatus,
  ROUND_LIMITS,
  MIN_PERSONS_PER_TABLE,
  TERMINAL_STATUSES,
} from "../domain/conclave.js";
import { toDate, toIso } from "../utils/firestore.js";
import { notifyConclave } from "./notification.service.js";

export const conclaveRef = (id: string) =>
  db.collection(collections.conclaves).doc(id);

const conclaveDocCache = new Map<string, { ref: any; data: any; doc: any }>();
let conclavesListCache: any[] = [];

export function clearConclaveCache() {
  conclaveDocCache.clear();
  conclavesListCache = [];
}

export async function getConclaveOrThrow(id: string) {
  const cached = conclaveDocCache.get(id);
  if (cached) return cached;

  try {
    const doc = await conclaveRef(id).get();
    if (!doc.exists) {
      throw ApiError.notFound("Conclave not found.");
    }
    const data = doc.data()!;
    const res = { ref: conclaveRef(id), data, doc };
    conclaveDocCache.set(id, res);
    return res;
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    throw ApiError.notFound("Conclave not found or database unavailable.");
  }
}

interface CreateInput {
  name?: string;
  venueLocation?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  regStartDate?: string;
  regEndDate?: string;
  dateRange?: string;
  startTime?: string;
  endTime?: string;
  coordinator?: string;
  creator?: string;
  description?: string;
  status?: string;
  chiefGuests?: unknown;
  personsPerTable?: number;
  roundCount?: number;
  memberLimit?: number;
  captainLimit?: number;
  region?: string;
  paymentDetails?: {
    bankName?: string;
    accountNumber?: string;
    ifscCode?: string;
    accountHolderName?: string;
    upiId?: string;
    upiQrImageUrl?: string;
    registrationFee?: number;
  };
}

/**
 * Validates the knobs the engine depends on.
 */
export function validateConfig(personsPerTable: number, roundCount: number) {
  if (!Number.isInteger(personsPerTable) || personsPerTable < MIN_PERSONS_PER_TABLE) {
    throw ApiError.badRequest(
      `personsPerTable must be a whole number of at least ${MIN_PERSONS_PER_TABLE}.`,
    );
  }
  if (
    !Number.isInteger(roundCount) ||
    roundCount < ROUND_LIMITS.min ||
    roundCount > ROUND_LIMITS.max
  ) {
    throw ApiError.badRequest(
      `roundCount must be between ${ROUND_LIMITS.min} and ${ROUND_LIMITS.max}.`,
    );
  }
}

/**
/**
 * Parses time string (e.g. "09:00", "09:00 AM", "17:30") into hours and minutes.
 */
function parseTimeComponents(val: unknown): { hours: number; minutes: number } | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const match = val.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const meridian = match[3]?.toUpperCase();
      if (meridian === 'PM' && h < 12) h += 12;
      if (meridian === 'AM' && h === 12) h = 0;
      return { hours: h, minutes: m };
    }
  }
  const d = toDate(val);
  if (d && !isNaN(d.getTime())) {
    return { hours: d.getHours(), minutes: d.getMinutes() };
  }
  return null;
}

/**
 * Evaluates conclave status dynamically based on current date/time vs reg dates and event start/end dates & times.
 * A conclave is shown as "running" ONLY if its start date & start time have already arrived!
 */
export function evaluateConclaveStatus(data: any): { status: string; isRegistrationOpen: boolean } {
  try {
    const now = new Date();

    // Preserve terminal statuses an admin has set explicitly (completed or
    // cancelled). These are final decisions and must NOT be recomputed from the
    // time window — otherwise a conclave ended early, before its scheduled
    // endDateTime, or one whose rounds have run (currentRound > 0), flips back to
    // "running" below and the app keeps showing it as a live conclave.
    if (data?.status && TERMINAL_STATUSES.has(data.status)) {
      return { status: data.status, isRegistrationOpen: false };
    }

    const regStart = data?.regStartDate ? toDate(data.regStartDate) : null;
    const regEnd = data?.regEndDate ? toDate(data.regEndDate) : null;

    const eventStart = data?.date ? toDate(data.date) : (data?.startDate ? toDate(data.startDate) : null);
    const eventEnd = data?.endDate ? toDate(data.endDate) : (data?.date ? toDate(data.date) : null);

    const startTimeComp = parseTimeComponents(data?.startTime);
    const endTimeComp = parseTimeComponents(data?.endTime);

    // Build precise start Date + Time
    let startDateTime: Date | null = null;
    if (eventStart && !isNaN(eventStart.getTime())) {
      startDateTime = new Date(eventStart);
      if (startTimeComp) {
        startDateTime.setHours(startTimeComp.hours, startTimeComp.minutes, 0, 0);
      } else {
        startDateTime.setHours(0, 0, 0, 0);
      }
    }

    // Build precise end Date + Time
    let endDateTime: Date | null = null;
    if (eventEnd && !isNaN(eventEnd.getTime())) {
      endDateTime = new Date(eventEnd);
      if (endTimeComp) {
        endDateTime.setHours(endTimeComp.hours, endTimeComp.minutes, 59, 999);
      } else {
        endDateTime.setHours(23, 59, 59, 999);
      }
    } else if (startDateTime) {
      endDateTime = new Date(startDateTime);
      if (endTimeComp) {
        endDateTime.setHours(endTimeComp.hours, endTimeComp.minutes, 59, 999);
      } else {
        endDateTime.setHours(23, 59, 59, 999);
      }
    }

    // 1. Completed if event end date & time has passed
    if (endDateTime && now > endDateTime) {
      return { status: ConclaveStatus.completed, isRegistrationOpen: false };
    }

    // 2. Running ONLY if event start date & time has already arrived!
    // (Or if admin explicitly started live rounds: currentRound > 0)
    const hasLiveRounds = Number(data?.currentRound) > 0;
    if (startDateTime && (now >= startDateTime || hasLiveRounds)) {
      return { status: ConclaveStatus.running, isRegistrationOpen: false };
    }

    // 3. If start time has NOT started yet, it CANNOT be running:
    if (regEnd) {
      const regEndDay = new Date(regEnd);
      regEndDay.setHours(23, 59, 59, 999);
      if (now > regEndDay) {
        return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
      }
    }

    if (regStart) {
      const regStartDay = new Date(regStart);
      regStartDay.setHours(0, 0, 0, 0);
      if (now < regStartDay) {
        return { status: ConclaveStatus.registrationNotOpen, isRegistrationOpen: false };
      }
    }

    // If event is today or soon and reg is closed, or open:
    return { status: ConclaveStatus.registrationOpen, isRegistrationOpen: true };
  } catch (err) {
    return {
      status: data?.status || ConclaveStatus.registrationOpen,
      isRegistrationOpen: data?.isRegistrationOpen ?? true
    };
  }
}

export function normalizeTime(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d{1,2}:\d{2}/.test(trimmed)) {
      return trimmed;
    }
    const d = toDate(trimmed);
    if (d && !isNaN(d.getTime())) {
      const hours = String(d.getHours()).padStart(2, "0");
      const mins = String(d.getMinutes()).padStart(2, "0");
      return `${hours}:${mins}`;
    }
    return trimmed;
  }
  const d = toDate(val);
  if (d && !isNaN(d.getTime())) {
    const hours = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${mins}`;
  }
  return null;
}

export async function createConclave(input: CreateInput) {
  if (!input.name || !input.venueLocation) {
    throw ApiError.badRequest("name and venueLocation are required.");
  }

  const personsPerTable = input.personsPerTable ?? 7;
  const roundCount = input.roundCount ?? 6;
  validateConfig(personsPerTable, roundCount);

  const evalResult = evaluateConclaveStatus({
    regStartDate: input.regStartDate,
    regEndDate: input.regEndDate,
    date: input.date,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  const statusToSet = input.status || evalResult.status;
  const isRegOpen = evalResult.isRegistrationOpen;

  const ref = await db.collection(collections.conclaves).add({
    name: input.name,
    venueLocation: input.venueLocation,
    region: input.region || "Global BNI Network",
    coordinator: input.coordinator || "",
    creator: input.creator || "",
    description: input.description || "",
    dateRange: input.dateRange || "",
    date: input.date ? new Date(input.date) : new Date(),
    endDate: input.endDate ? new Date(input.endDate) : null,
    regStartDate: input.regStartDate ? new Date(input.regStartDate) : null,
    regEndDate: input.regEndDate ? (() => { const d = new Date(input.regEndDate); d.setHours(23, 59, 59, 999); return d; })() : null,
    startTime: normalizeTime(input.startTime),
    endTime: normalizeTime(input.endTime),
    chiefGuests: Array.isArray(input.chiefGuests) ? input.chiefGuests : [],
    status: statusToSet,
    isRegistrationOpen: isRegOpen,
    personsPerTable,
    roundCount,
    memberLimit: Number(input.memberLimit) || 100,
    captainLimit: Number(input.captainLimit) || 12,
    paymentDetails: input.paymentDetails || null,
    currentRound: 0,
    schedule: null,
    participants: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  clearConclaveCache();
  return ref.id;
}

export async function updateConclave(id: string, body: Record<string, unknown>) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.running || status === ConclaveStatus.completed) {
    throw ApiError.conflict(`Cannot edit a conclave that is ${status}.`);
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.venueLocation !== undefined) updates.venueLocation = body.venueLocation;
  if (body.region !== undefined) updates.region = body.region;
  if (body.coordinator !== undefined) updates.coordinator = body.coordinator;
  if (body.creator !== undefined) updates.creator = body.creator;
  if (body.description !== undefined) updates.description = body.description;
  if (body.dateRange !== undefined) updates.dateRange = body.dateRange;
  if (body.memberLimit !== undefined) updates.memberLimit = Number(body.memberLimit) || 100;
  if (body.captainLimit !== undefined) updates.captainLimit = Number(body.captainLimit) || 12;
  if (body.paymentDetails !== undefined) updates.paymentDetails = body.paymentDetails;
  if (body.date !== undefined) updates.date = body.date ? new Date(body.date as string) : null;
  if (body.startDate !== undefined) updates.startDate = body.startDate ? new Date(body.startDate as string) : null;
  if (body.endDate !== undefined) updates.endDate = body.endDate ? new Date(body.endDate as string) : null;
  if (body.regStartDate !== undefined) updates.regStartDate = body.regStartDate ? new Date(body.regStartDate as string) : null;
  if (body.regEndDate !== undefined) {
    if (body.regEndDate) {
      const d = new Date(body.regEndDate as string);
      d.setHours(23, 59, 59, 999);
      updates.regEndDate = d;
    } else {
      updates.regEndDate = null;
    }
  }
  if (body.startTime !== undefined) updates.startTime = normalizeTime(body.startTime);
  if (body.endTime !== undefined) updates.endTime = normalizeTime(body.endTime);
  if (body.status !== undefined) updates.status = body.status;

  const mergedData = { ...data, ...updates };
  const evalResult = evaluateConclaveStatus(mergedData);
  if (body.status === undefined) {
    updates.status = evalResult.status;
  }
  updates.isRegistrationOpen = evalResult.isRegistrationOpen;
  updates.updatedAt = new Date();

  if (body.personsPerTable !== undefined || body.roundCount !== undefined) {
    if (data.schedule) {
      throw ApiError.conflict(
        "A schedule already exists. Changing persons-per-table or round count would invalidate it — regenerate the schedule instead.",
      );
    }
    const p = (body.personsPerTable as number) ?? data.personsPerTable;
    const r = (body.roundCount as number) ?? data.roundCount;
    validateConfig(p, r);
    updates.personsPerTable = p;
    updates.roundCount = r;
  }

  if (Object.keys(updates).length === 0) {
    throw ApiError.badRequest("Nothing to update.");
  }

  updates.updatedAt = new Date();

  clearConclaveCache();
  await ref.update(updates);
  return Object.keys(updates);
}

/** Open or close registration. Two-way, unlike a one-shot "close". */
export async function setRegistrationOpen(id: string, open: boolean) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (TERMINAL_STATUSES.has(status) || status === ConclaveStatus.running) {
    throw ApiError.conflict(
      `Cannot change registration on a conclave that is ${status}.`,
    );
  }

  await ref.update({
    isRegistrationOpen: open,
    status: open ? ConclaveStatus.registrationOpen : ConclaveStatus.registrationClosed,
  });
}

/**
 * Call a conclave off before it starts.
 */
export async function cancelConclave(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.completed) {
    throw ApiError.conflict("A completed conclave cannot be cancelled.");
  }

  if (status === ConclaveStatus.running) {
    throw ApiError.conflict(
      "This conclave is running — it cannot be cancelled. Use End Conclave to " +
        "stop it now; members keep their attendance and referrals, and get their " +
        "summaries.",
    );
  }

  if (status === ConclaveStatus.cancelled) {
    throw ApiError.conflict("This conclave is already cancelled.");
  }

  await ref.update({
    status: ConclaveStatus.cancelled,
    isRegistrationOpen: false,
    cancelledAt: new Date(),
  });
}

/** Lock the schedule for a conclave without ending the conclave. */
export async function lockConclaveSchedule(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  const evalResult = evaluateConclaveStatus(data);
  await ref.update({
    isScheduleLocked: true,
    status: data.status === ConclaveStatus.completed ? ConclaveStatus.completed : evalResult.status,
    updatedAt: new Date()
  });
  clearConclaveCache();
}

/**
 * End the conclave.
 */
export async function completeConclave(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.completed) {
    throw ApiError.conflict("This conclave is already completed.");
  }
  if (status !== ConclaveStatus.running) {
    throw ApiError.conflict(
      `Only a running conclave can be completed (this one is ${status}).`,
    );
  }

  await ref.update({
    status: ConclaveStatus.completed,
    isRegistrationOpen: false,
    completedAt: new Date(),
  });

  await notifyConclave(id, {
    title: "The conclave has ended",
    body: "Open the app to see your summary, your referrals, and whether your data has synced.",
    data: { conclaveId: id, type: "conclave_completed" },
  });

  const finalRound = data.currentRound ?? 0;
  const roundCount = data.roundCount ?? 0;
  return { finalRound, roundCount, endedEarly: finalRound < roundCount };
}

/**
 * Start a round.
 */
export async function startRound(id: string, roundNumber: number, adminUid: string) {
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw ApiError.badRequest("roundNumber must be a positive whole number.");
  }

  const { ref, data } = await getConclaveOrThrow(id);

  if (roundNumber > (data.roundCount ?? 0)) {
    throw ApiError.badRequest(
      `This conclave has only ${data.roundCount} rounds.`,
    );
  }

  if (roundNumber === 1) {
    if (!data.schedule) {
      throw ApiError.badRequest(
        "No schedule has been generated. Generate one before starting round 1.",
      );
    }

    const running = await db
      .collection(collections.conclaves)
      .where("status", "==", ConclaveStatus.running)
      .where("startedBy", "==", adminUid)
      .get();

    const other = running.docs.find((d) => d.id !== id);
    if (other) {
      throw ApiError.conflict(
        `You are already running "${other.data().name}". End it before starting another — ` +
          `rounds are advanced by hand, and you cannot be in two rooms at once.`,
        { runningConclaveId: other.id },
      );
    }
  }

  const roundStartedAt = new Date();
  await ref.update({
    status: ConclaveStatus.running,
    isRegistrationOpen: false,
    currentRound: roundNumber,
    currentRoundStartedAt: roundStartedAt,
    ...(roundNumber === 1 ? { startedBy: adminUid } : {}),
  });

  try {
    await notifyConclave(id, {
      title: `Round ${roundNumber} has started`,
      body: "Go to your table — open the app to see who you're sitting with.",
      data: { conclaveId: id, roundNumber: String(roundNumber), type: "round_started" },
    });
  } catch {}

  return roundStartedAt;
}

export async function listConclaves(region?: string) {
  try {
    let snap: any;
    try {
      snap = await db.collection(collections.conclaves).orderBy("date", "desc").get();
    } catch {
      snap = await db.collection(collections.conclaves).get();
    }

    let docs = snap.docs;
    if (region) {
      const targetNorm = String(region || '').toLowerCase().replace(/\s+region$/, '').trim();
      docs = docs.filter((doc: any) => {
        const docNorm = String(doc.data().region || '').toLowerCase().replace(/\s+region$/, '').trim();
        return !targetNorm || docNorm === targetNorm || docNorm.includes(targetNorm) || targetNorm.includes(docNorm);
      });
    }

    docs.sort((a: any, b: any) => {
      const da = toDate(a.data().date)?.getTime() || 0;
      const dbDate = toDate(b.data().date)?.getTime() || 0;
      return dbDate - da;
    });

    const list = await Promise.all(
      docs.map(async (doc: any) => {
        let regCount = 0;
        try {
          const count = await doc.ref.collection(collections.registrations).count().get();
          regCount = count.data().count;
        } catch {
          // Ignore subcollection count error
        }
        const d = doc.data();
        const countFromSubcoll = regCount;
        const countFromParticipants = Array.isArray(d.participants) ? d.participants.length : 0;
        const actualCount = countFromSubcoll > 0 ? countFromSubcoll : countFromParticipants;

        // Self-heal: If status was marked completed before any rounds were run, reset to dynamic status
        if (d.status === "completed" && (!d.currentRound || d.currentRound === 0)) {
          const evalResult = evaluateConclaveStatus(d);
          d.status = evalResult.status;
          d.isRegistrationOpen = evalResult.isRegistrationOpen;
          doc.ref.update({ status: evalResult.status, isRegistrationOpen: evalResult.isRegistrationOpen }).catch(() => {});
        } else if (d.status !== ConclaveStatus.completed && d.status !== ConclaveStatus.cancelled) {
          const evalResult = evaluateConclaveStatus(d);
          d.status = evalResult.status;
          d.isRegistrationOpen = evalResult.isRegistrationOpen;
        }

        const item = {
          id: doc.id,
          ...d,
          startDate: toIso(d.startDate || d.date),
          date: toIso(d.date || d.startDate),
          endDate: toIso(d.endDate),
          regStartDate: toIso(d.regStartDate),
          regEndDate: toIso(d.regEndDate),
          startTime: normalizeTime(d.startTime),
          endTime: normalizeTime(d.endTime),
          createdAt: toIso(d.createdAt),
          updatedAt: toIso(d.updatedAt),
          registrationCount: actualCount,
        };
        conclaveDocCache.set(doc.id, { ref: doc.ref, data: d, doc });
        return item;
      }),
    );

    if (list.length > 0) {
      conclavesListCache = list;
    }
    return list;
  } catch (err: any) {
    console.warn("listConclaves falling back to local cache:", err?.message || err);
    return conclavesListCache;
  }
}

export async function deleteConclave(id: string) {
  const ref = db.collection(collections.conclaves).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    throw ApiError.notFound(`Conclave with ID "${id}" does not exist.`);
  }
  await ref.delete();
}

