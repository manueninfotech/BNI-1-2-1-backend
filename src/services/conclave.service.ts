import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import {
  ConclaveStatus,
  ROUND_LIMITS,
  MIN_PERSONS_PER_TABLE,
  TERMINAL_STATUSES,
} from "../domain/conclave.js";
import { toDate, toIso } from "../utils/firestore.js";
import { notifyConclave, notifyUser, recordUserNotification } from "./notification.service.js";
import { resolveNotification, getConclaveDefaults, getRoundTiming } from "./settings.service.js";

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
  regStartTime?: string;
  regEndTime?: string;
  registrationOverride?: string;
  isRegistrationOpen?: boolean;
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
 * Combines a date with an "HH:mm" time, defaulting to the start (00:00:00.000)
 * or end (23:59:59.999) of the day when no time is given. null for a missing or
 * invalid date.
 */
function combineDateTime(base: Date | null, time: unknown, edge: "start" | "end"): Date | null {
  if (!base || isNaN(base.getTime())) return null;
  const comp = parseTimeComponents(time);
  const d = new Date(base);
  if (comp) d.setHours(comp.hours, comp.minutes, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  else d.setHours(edge === "end" ? 23 : 0, edge === "end" ? 59 : 0, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  return d;
}

/**
 * Enforces the conclave's timing rules at create and edit — the whole point is
 * that a nonsensical window (an event that ends before it starts, or
 * registration that stays open after the conclave has begun) can never be saved.
 * Throws ApiError.badRequest with a human message on the first violation. Each
 * field is only checked when present, so a partial edit that doesn't touch dates
 * passes untouched.
 */
export function validateConclaveDates(
  d: {
    date?: unknown; startDate?: unknown; endDate?: unknown; startTime?: unknown; endTime?: unknown;
    regStartDate?: unknown; regEndDate?: unknown; regStartTime?: unknown; regEndTime?: unknown;
  },
  opts: { isNew: boolean },
) {
  const now = new Date();
  const eventStart = combineDateTime(
    d.date ? toDate(d.date) : (d.startDate ? toDate(d.startDate) : null), d.startTime, "start",
  );
  const eventEnd = combineDateTime(
    d.endDate ? toDate(d.endDate) : (d.date ? toDate(d.date) : null), d.endTime, "end",
  );
  const regStart = combineDateTime(d.regStartDate ? toDate(d.regStartDate) : null, d.regStartTime, "start");
  const regEnd = combineDateTime(d.regEndDate ? toDate(d.regEndDate) : null, d.regEndTime, "end");

  if (eventStart && eventEnd && eventEnd < eventStart) {
    throw ApiError.badRequest("The conclave can't end before it starts — check the event date and time.");
  }
  if (regStart && regEnd && regEnd <= regStart) {
    throw ApiError.badRequest("Registration must open before it closes.");
  }
  if (regEnd && eventStart && regEnd > eventStart) {
    throw ApiError.badRequest(
      "Registration must close before the conclave starts — it can't stay open after the event has begun.",
    );
  }
  if (opts.isNew && eventStart && eventStart < now) {
    throw ApiError.badRequest("The conclave can't start in the past.");
  }
}

/**
 * Evaluates conclave status dynamically based on current date/time vs reg dates and event start/end dates & times.
 */
export function evaluateConclaveStatus(data: any): { status: string; isRegistrationOpen: boolean } {
  try {
    const rawStatus = String(data?.status || "").trim();
    const statusLower = rawStatus.toLowerCase();

    // 1. Preserve terminal statuses (completed or cancelled) - never auto-reopen
    if (statusLower === "completed" || statusLower === "cancelled") {
      return {
        status: statusLower === "completed" ? ConclaveStatus.completed : ConclaveStatus.cancelled,
        isRegistrationOpen: false,
      };
    }

    // 2. An admin-started conclave stays running until an admin explicitly finishes it!
    // Conclaves never start or end automatically on a clock.
    if (statusLower === "running") {
      return { status: ConclaveStatus.running, isRegistrationOpen: false };
    }

    // 3. Registrations are strictly closed once the conclave schedule is marked as locked!
    if (data?.isScheduleLocked || statusLower === "locked") {
      return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
    }

    // 4. Admin registration override (Open / Closed)
    const registrationOverride = String(data?.registrationOverride ?? "").toLowerCase();
    if (registrationOverride === "open") {
      return { status: ConclaveStatus.registrationOpen, isRegistrationOpen: true };
    }
    if (registrationOverride === "closed") {
      return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
    }

    // 5. If registration start date is in the future and not overridden:
    const now = new Date();
    const regStart = data?.regStartDate ? toDate(data.regStartDate) : null;
    const regStartDateTime = combineDateTime(regStart, data?.regStartTime, "start");
    if (regStartDateTime && now < regStartDateTime) {
      return { status: ConclaveStatus.registrationNotOpen, isRegistrationOpen: false };
    }

    // 6. Registrations remain open up to the conclave status being marked as locked!
    return { status: ConclaveStatus.registrationOpen, isRegistrationOpen: true };
  } catch (err) {
    return {
      status: data?.status || ConclaveStatus.registrationOpen,
      isRegistrationOpen: data?.isRegistrationOpen ?? true,
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

  const defaults = await getConclaveDefaults();
  const personsPerTable = input.personsPerTable ?? defaults.personsPerTable;
  const roundCount = input.roundCount ?? defaults.roundCount;
  validateConfig(personsPerTable, roundCount);

  // Reject a nonsensical window before anything is written.
  validateConclaveDates(input, { isNew: true });

  const override = input.isRegistrationOpen === false ? "closed" : (input.registrationOverride || "open");
  const evalResult = evaluateConclaveStatus({
    regStartDate: input.regStartDate,
    regEndDate: input.regEndDate,
    regStartTime: input.regStartTime,
    regEndTime: input.regEndTime,
    date: input.date,
    startDate: input.startDate,
    endDate: input.endDate,
    startTime: input.startTime,
    endTime: input.endTime,
    registrationOverride: override,
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
    regEndDate: input.regEndDate ? new Date(input.regEndDate) : null,
    regStartTime: normalizeTime(input.regStartTime),
    regEndTime: normalizeTime(input.regEndTime),
    registrationOverride: override,
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
  if (body.regEndDate !== undefined) updates.regEndDate = body.regEndDate ? new Date(body.regEndDate as string) : null;
  if (body.regStartTime !== undefined) updates.regStartTime = normalizeTime(body.regStartTime);
  if (body.regEndTime !== undefined) updates.regEndTime = normalizeTime(body.regEndTime);
  if (body.startTime !== undefined) updates.startTime = normalizeTime(body.startTime);
  if (body.endTime !== undefined) updates.endTime = normalizeTime(body.endTime);
  if (body.status !== undefined) updates.status = body.status;
  // The admin's open/closed intent. isRegistrationOpen=false (the form toggle) is
  // the same signal.
  if (body.registrationOverride !== undefined) {
    updates.registrationOverride = String(body.registrationOverride);
  } else if (body.isRegistrationOpen !== undefined) {
    updates.registrationOverride = body.isRegistrationOpen ? "open" : "closed";
  }

  const mergedData = { ...data, ...updates };

  // Validate the RESULT of the edit (merged), so a partial change that creates a
  // bad window — e.g. moving registration past the event start — is rejected.
  validateConclaveDates(mergedData, { isNew: false });

  const evalResult = evaluateConclaveStatus(mergedData);
  if (body.status === undefined) {
    updates.status = evalResult.status;
  }
  updates.isRegistrationOpen = evalResult.isRegistrationOpen;

  if (mergedData.isScheduleLocked || String(mergedData.status || '').toLowerCase() === 'locked') {
    updates.registrationOverride = "closed";
    updates.isRegistrationOpen = false;
    if (body.status === undefined && data.status !== ConclaveStatus.completed) {
      updates.status = ConclaveStatus.registrationClosed;
    }
  }

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
  void notifyConclaveDetailsUpdated(id, data, updates).catch(() => { });
  return Object.keys(updates);
}

/**
 * Detects changes to key conclave details (name, date/postponed, time, venue, status)
 * and notifies all registered members via FCM push + in-app inbox.
 */
export async function notifyConclaveDetailsUpdated(
  conclaveId: string,
  oldData: any,
  updates: Record<string, unknown>
): Promise<void> {
  try {
    const changes: string[] = [];
    const conclaveName = String(updates.name || oldData.name || "BNI Conclave").trim();

    // 1. Name change
    if (updates.name !== undefined && String(updates.name).trim() !== String(oldData.name || "").trim()) {
      changes.push(`Name changed to "${updates.name}"`);
    }

    // 2. Date change / Postponed
    const oldDateObj = oldData.startDate || oldData.date ? new Date(oldData.startDate || oldData.date) : null;
    const newDateObj = (updates.startDate || updates.date) ? new Date((updates.startDate || updates.date) as string | Date) : null;
    if (newDateObj && oldDateObj && !isNaN(newDateObj.getTime()) && !isNaN(oldDateObj.getTime())) {
      const oldDateStr = oldDateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const newDateStr = newDateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      if (oldDateStr !== newDateStr) {
        if (newDateObj.getTime() > oldDateObj.getTime()) {
          changes.push(`Event Postponed: Rescheduled to ${newDateStr}`);
        } else {
          changes.push(`Date changed to ${newDateStr}`);
        }
      }
    } else if (newDateObj && !oldDateObj && !isNaN(newDateObj.getTime())) {
      const newDateStr = newDateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      changes.push(`Date set to ${newDateStr}`);
    }

    // 3. Timing change
    const oldStartTime = String(oldData.startTime || "").trim();
    const newStartTime = updates.startTime !== undefined ? String(updates.startTime || "").trim() : oldStartTime;
    const oldEndTime = String(oldData.endTime || "").trim();
    const newEndTime = updates.endTime !== undefined ? String(updates.endTime || "").trim() : oldEndTime;

    if ((updates.startTime !== undefined && newStartTime !== oldStartTime) ||
      (updates.endTime !== undefined && newEndTime !== oldEndTime)) {
      const formatTime = (t: string) => {
        if (!t) return "";
        const m = t.match(/^(\d{1,2}):(\d{2})/);
        if (m) {
          let h = parseInt(m[1], 10);
          const mins = m[2];
          const meridian = h >= 12 ? "PM" : "AM";
          if (h > 12) h -= 12;
          if (h === 0) h = 12;
          return `${h}:${mins} ${meridian}`;
        }
        return t;
      };
      const displayNewTiming = `${formatTime(newStartTime)} – ${formatTime(newEndTime)}`.trim();
      changes.push(`Timing updated to ${displayNewTiming}`);
    }

    // 4. Venue change
    const oldVenue = String(oldData.venueLocation || oldData.venue || "").trim();
    const newVenue = updates.venueLocation !== undefined
      ? String(updates.venueLocation || "").trim()
      : (updates.venue !== undefined ? String(updates.venue || "").trim() : oldVenue);
    if ((updates.venueLocation !== undefined || updates.venue !== undefined) && newVenue && newVenue !== oldVenue) {
      changes.push(`Venue moved to ${newVenue}`);
    }

    // 5. Status / Cancellation / Postponement
    if (updates.status !== undefined && String(updates.status).toLowerCase() !== String(oldData.status || "").toLowerCase()) {
      const statusLower = String(updates.status).toLowerCase();
      if (statusLower === "cancelled") {
        changes.push("The conclave has been CANCELLED");
      } else if (statusLower.includes("postpone")) {
        changes.push("Event has been marked as POSTPONED");
      }
    }

    // If no attendee-facing details changed, do nothing
    if (changes.length === 0) return;

    const isPostponedOrCancelled = changes.some(c =>
      c.toLowerCase().includes("postpone") || c.toLowerCase().includes("cancelled") || c.toLowerCase().includes("reschedule")
    );
    const title = isPostponedOrCancelled
      ? `Important Update: ${conclaveName}`
      : `Conclave Details Updated: ${conclaveName}`;
    const body = changes.join(". ") + ".";

    const payload = {
      title,
      body,
      type: "conclave_updated",
      data: {
        conclaveId,
        type: "conclave_updated",
        name: conclaveName,
        changes: changes.join("; "),
        updatedAt: new Date().toISOString()
      }
    };

    // 1. Broadcast to conclave FCM topic
    void notifyConclave(conclaveId, payload).catch(() => { });

    // 2. Notify all registered attendees
    const ref = conclaveRef(conclaveId);
    const regsSnap = await ref.collection(collections.registrations).get();

    for (const doc of regsSnap.docs) {
      const uid = doc.id;
      // Send FCM push notification to individual member
      void notifyUser(uid, payload, "general").catch(() => { });
      // Record notification in user's in-app inbox
      void recordUserNotification(uid, payload).catch(() => { });
    }
  } catch (err) {
    console.error(`Failed to notify attendees for conclave ${conclaveId} updates:`, err);
  }
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

  if (data.isScheduleLocked && open) {
    throw ApiError.conflict(
      "Cannot open registrations on a conclave whose schedule is locked.",
    );
  }

  // Record the admin's intent as the override and recompute. The override can
  // bypass registration dates, but not event lifecycle, locked schedule, or terminal status.
  const override = open ? "open" : "closed";
  const evalResult = evaluateConclaveStatus({ ...data, registrationOverride: override });
  await ref.update({
    registrationOverride: override,
    isRegistrationOpen: evalResult.isRegistrationOpen,
    status: evalResult.status,
    updatedAt: new Date(),
  });
  clearConclaveCache();
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
  void notifyConclaveDetailsUpdated(id, data, { status: "cancelled" }).catch(() => { });
}

/** Lock the schedule for a conclave without ending the conclave. */
export async function lockConclaveSchedule(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  await ref.update({
    isScheduleLocked: true,
    isRegistrationOpen: false,
    registrationOverride: "closed",
    status: data.status === ConclaveStatus.completed ? ConclaveStatus.completed : ConclaveStatus.registrationClosed,
    updatedAt: new Date()
  });
  clearConclaveCache();
  // Publishing the schedule is when everyone should be told: members that their
  // schedule is ready, captains which table they're anchoring. Best-effort.
  try { await notifyScheduleReady(id); } catch { }
}

/**
 * Tells every registered member their schedule is ready, and every captain the
 * table they're anchoring. Sent to each person's PERSONAL topic (subscribed on
 * sign-in), so it reaches them wherever they are in the app. Per-user
 * best-effort — one failure never blocks the rest.
 */
export async function notifyScheduleReady(id: string): Promise<{ captains: number; members: number }> {
  const { ref } = await getConclaveOrThrow(id);
  const regs = await ref.collection(collections.registrations).get();
  let captains = 0;
  let members = 0;
  for (const reg of regs.docs) {
    const r: any = reg.data();
    try {
      if (r.role === "captain") {
        await notifyUser(
          reg.id,
          {
            title: "You're a Table Captain ⭐",
            body: `You're the captain for Table ${r.tableNumber ?? "your table"}. Please take your table and get ready to scan.`,
            data: { conclaveId: id, type: "captain_assignment", tableNumber: String(r.tableNumber ?? "") },
          },
          "round_alerts",
        );
        captains++;
      } else {
        await notifyUser(
          reg.id,
          {
            title: "Your conclave schedule is ready 📋",
            body: "Tap to view your table and who you'll be meeting.",
            data: { conclaveId: id, type: "schedule_ready" },
          },
          "general",
        );
        members++;
      }
    } catch {
      // keep going; a single bad token must not stop the broadcast
    }
  }
  return { captains, members };
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
    isRoundPaused: false,
    roundPausedAt: null,
  });

  const endedMsg = await resolveNotification("conclaveEnded");
  await notifyConclave(id, {
    title: endedMsg.title,
    body: endedMsg.body,
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

  // Rounds auto-advance on the clock. If the admin tries to start a round that
  // has already begun or elapsed, block it — re-starting (e.g. round 2 when the
  // clock is already on round 3) would reset the anchor and yank everyone back.
  if (roundNumber > 1 && data.status === ConclaveStatus.running) {
    const anchor = toDate(data.currentRoundStartedAt);
    const prevRound = Number(data.currentRound) || 0;
    if (anchor && prevRound >= 1) {
      const timing = await getRoundTiming();
      const p = Math.max(1, Number(data.personsPerTable) || 1);
      const active = (timing.bioSeconds + timing.referralSeconds) * 1000 * p;
      const blockMin = Number(data.roundBlockMinutes);
      const roundMs =
        Number.isFinite(blockMin) && blockMin > 0
          ? active + Math.max(0, blockMin * 60 * 1000 - active)
          : active + timing.bufferSeconds * 1000;
      const liveRound =
        prevRound + Math.floor((Date.now() - anchor.getTime()) / roundMs);
      if (roundNumber <= liveRound) {
        const shown = Math.min(liveRound, Number(data.roundCount) || liveRound);
        throw ApiError.conflict(
          `Round ${roundNumber} has already run — the conclave is on round ${shown}. ` +
          `Rounds advance automatically, so you don't need to start them by hand.`,
          { liveRound: shown },
        );
      }
    }
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
    isRoundPaused: false,
    roundPausedAt: null,
    roundElapsedMsBeforePause: null,
    ...(roundNumber === 1 ? { startedBy: adminUid } : {}),
  });
  conclaveDocCache.delete(id);
  conclavesListCache = [];

  try {
    const startedMsg = await resolveNotification("roundStarted", { round: roundNumber });
    const roundData = {
      conclaveId: id,
      roundNumber: String(roundNumber),
      type: "round_started",
    };
    await notifyConclave(id, { title: startedMsg.title, body: startedMsg.body, data: roundData });
    // Also hit each registered member's PERSONAL topic. They subscribe to that
    // on sign-in, whereas the conclave topic is only subscribed on the active-
    // round screen — so a topic-only push reaches almost no one before rounds.
    const roundRegs = await ref.collection(collections.registrations).get();
    for (const reg of roundRegs.docs) {
      void notifyUser(reg.id, { title: startedMsg.title, body: startedMsg.body, data: roundData }, "round_alerts").catch(() => { });
    }
  } catch { }

  return roundStartedAt;
}

/**
 * Pause the active round timer.
 */
export async function pauseRound(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  if (data.status !== ConclaveStatus.running) {
    throw ApiError.badRequest("Only a running conclave round can be paused.");
  }
  if (data.isRoundPaused) {
    return { isRoundPaused: true, pausedAt: data.roundPausedAt };
  }

  const anchor = toDate(data.currentRoundStartedAt);
  const elapsedMs = anchor ? Math.max(0, Date.now() - anchor.getTime()) : 0;
  const pausedAt = new Date();

  await ref.update({
    isRoundPaused: true,
    roundPausedAt: pausedAt,
    roundElapsedMsBeforePause: elapsedMs,
  });
  conclaveDocCache.delete(id);
  conclavesListCache = [];

  try {
    await notifyConclave(id, {
      title: "Round Paused",
      body: `Round ${data.currentRound || 1} has been paused by the admin.`,
      data: { conclaveId: id, type: "round_paused" },
    });
  } catch { }

  return { isRoundPaused: true, pausedAt, elapsedMs };
}

/**
 * Resume the paused round timer.
 */
export async function resumeRound(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  if (data.status !== ConclaveStatus.running) {
    throw ApiError.badRequest("Only a running conclave round can be resumed.");
  }
  if (!data.isRoundPaused) {
    return { isRoundPaused: false, startedAt: data.currentRoundStartedAt };
  }

  // Calculate new anchor: current time minus elapsed time already spent before pause
  const elapsedMs = Number(data.roundElapsedMsBeforePause) || 0;
  const newStartedAt = new Date(Date.now() - elapsedMs);

  await ref.update({
    isRoundPaused: false,
    roundPausedAt: null,
    roundElapsedMsBeforePause: null,
    currentRoundStartedAt: newStartedAt,
  });
  conclaveDocCache.delete(id);
  conclavesListCache = [];

  try {
    await notifyConclave(id, {
      title: "Round Resumed",
      body: `Round ${data.currentRound || 1} has resumed!`,
      data: { conclaveId: id, type: "round_resumed" },
    });
  } catch { }

  return { isRoundPaused: false, currentRoundStartedAt: newStartedAt };
}

/**
 * Force-close the current round.
 */
export async function closeRound(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  if (data.status !== ConclaveStatus.running) {
    throw ApiError.badRequest("Only a running conclave round can be closed.");
  }

  const curRound = Number(data.currentRound) || 1;
  const totalRounds = Number(data.roundCount) || 4;

  // If on final round, complete the conclave
  if (curRound >= totalRounds) {
    return await completeConclave(id);
  }

  // Otherwise, fast-forward anchor to 16 minutes in past so current round is marked ended
  const endedAnchor = new Date(Date.now() - 16 * 60 * 1000);
  await ref.update({
    isRoundPaused: false,
    roundPausedAt: null,
    roundElapsedMsBeforePause: null,
    currentRoundStartedAt: endedAnchor,
  });
  conclaveDocCache.delete(id);
  conclavesListCache = [];

  try {
    await notifyConclave(id, {
      title: `Round ${curRound} Closed`,
      body: `Round ${curRound} has concluded.`,
      data: { conclaveId: id, type: "round_ended", roundNumber: String(curRound) },
    });
  } catch { }

  return { closedRound: curRound, isEnded: true };
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

        // Self-heal: a conclave marked completed before any rounds ran (currentRound==0)
        // AND without an explicit admin completion (no completedAt) is almost always a
        // stale/bogus status — recompute it from the time window. Two guards keep this
        // from ever re-opening a genuinely-finished conclave (the reported bug where a
        // deliberately-completed conclave kept coming back):
        //   1. completedAt present  → an admin ended it on purpose; always trusted.
        //   2. the recomputed status is itself "completed" (event day has passed) → leave it.
        if (d.status === "completed" && (!d.currentRound || d.currentRound === 0) && !d.completedAt) {
          const evalResult = evaluateConclaveStatus({ ...d, status: undefined });
          if (evalResult.status !== ConclaveStatus.completed) {
            d.status = evalResult.status;
            d.isRegistrationOpen = evalResult.isRegistrationOpen;
            doc.ref.update({ status: evalResult.status, isRegistrationOpen: evalResult.isRegistrationOpen }).catch(() => { });
          }
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
  // Without this the deleted conclave lingers in the cached list, so the admin
  // dashboard summary and dropdowns keep showing it. Create/update/complete
  // already clear the cache; delete was missed.
  clearConclaveCache();
}

