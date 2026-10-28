import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, registrations, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import {
  ConclaveStatus,
  ROUND_LIMITS,
  MIN_PERSONS_PER_TABLE,
  TERMINAL_STATUSES,
} from "../domain/conclave.js";
import { notifyConclave, notifyUser, recordUserNotification } from "./notification.service.js";
import { notifyConclaveChanged } from "./live.service.js";
import {
  DEFAULT_MOVE_SECONDS,
  EXTEND_SECONDS_OPTIONS,
  MAX_EXTENSION_SECONDS,
  MAX_PERSONS_PER_TABLE,
  MOVE_SECONDS_OPTIONS,
  liveClock,
  materialize,
  phases,
} from "../domain/roundClock.js";
import { decodeDataUrl, deleteFile, uploadFile, type StoredFile } from "./storage.service.js";
import { resolveNotification, getConclaveDefaults, getCachedRoundTiming, getCachedConclaveDefaults } from "./settings.service.js";

/**
 * Conclaves: lifecycle, registration window, and live rounds.
 *
 * Every state change runs in a transaction that locks the conclave row
 * (SELECT … FOR UPDATE) and writes an audit "change" with the before → after
 * diff, so two admins acting at once can't interleave, and nothing changes
 * unrecorded. No in-process caches: they went stale across instances.
 */

export type ConclaveRow = typeof conclaves.$inferSelect;
type ConclavePatch = Partial<typeof conclaves.$inferInsert>;


// ---------------------------------------------------------------------------
// API shape — identical field names to the Firestore era, so clients don't change
// ---------------------------------------------------------------------------

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toView(row: ConclaveRow, registrationCount?: number) {
  return {
    // Legacy-only fields first, so real columns always win.
    ...(row.legacy ?? {}),
    id: row.id,
    name: row.name,
    description: row.description,
    venueLocation: row.venueLocation,
    region: row.region,
    coordinator: row.coordinator,
    creator: row.creator,
    theme: row.theme,
    dateRange: row.dateRange,
    date: iso(row.startDate),
    startDate: iso(row.startDate),
    endDate: iso(row.endDate),
    startTime: row.startTime,
    endTime: row.endTime,
    regStartDate: iso(row.regStartDate),
    regEndDate: iso(row.regEndDate),
    regStartTime: row.regStartTime,
    regEndTime: row.regEndTime,
    registrationOverride: row.registrationOverride,
    isRegistrationOpen: row.isRegistrationOpen,
    status: row.status,
    memberLimit: row.memberLimit,
    captainLimit: row.captainLimit,
    registrationFee: row.registrationFee,
    paymentDetails: row.paymentDetails,
    chiefGuests: row.chiefGuests,
    agendaDocument: row.agendaDocument,
    allowAdminAddMembers: row.allowAdminAddMembers,
    personsPerTable: row.personsPerTable ?? getCachedConclaveDefaults().personsPerTable,
    roundCount: row.roundCount ?? getCachedConclaveDefaults().roundCount,
    seed: row.seed,
    schedule: row.schedule,
    participants: row.participants,
    scheduleSummary: row.scheduleSummary,
    warnings: row.warnings,
    snapshot: row.snapshot,
    isScheduleLocked: row.isScheduleLocked,
    roundProgressionMode: row.roundProgressionMode ?? "manual",
    moveSeconds: row.moveSeconds ?? DEFAULT_MOVE_SECONDS,
    roundExtensionSeconds: row.roundExtensionSeconds ?? 0,
    roundTiming: getCachedRoundTiming(),
    currentRound: row.currentRound,
    currentRoundStartedAt: iso(row.currentRoundStartedAt),
    isRoundPaused: row.isRoundPaused,
    roundPausedAt: iso(row.roundPausedAt),
    roundElapsedMsBeforePause: row.roundElapsedMsBeforePause,
    startedBy: row.startedBy,
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(registrationCount !== undefined ? { registrationCount } : {}),
  };
}
export type ConclaveView = ReturnType<typeof toView>;

/** The conclave row and its API shape; 404 if it doesn't exist. */
export async function getConclaveOrThrow(id: string) {
  const [row] = await pgdb.select().from(conclaves).where(eq(conclaves.id, id));
  if (!row) throw ApiError.notFound("Conclave not found.");
  return { row, data: toView(row) };
}

/** Audit view of a conclave: everything except the bulky engine output. */
function auditable(row: ConclaveRow | null | undefined) {
  if (!row) return null;
  const { schedule, participants, snapshot, legacy, ...rest } = row;
  void schedule; void participants; void snapshot; void legacy;
  return rest;
}

/**
 * Locks the conclave row, lets `fn` decide the patch (or throw), applies it and
 * audits it — all in one transaction.
 */
async function mutate(
  id: string,
  action: string,
  fn: (row: ConclaveRow) => ConclavePatch | Promise<ConclavePatch>,
  metadata?: Record<string, unknown>,
): Promise<{ before: ConclaveRow; after: ConclaveRow }> {
  return pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(conclaves).where(eq(conclaves.id, id)).for("update");
    if (!before) throw ApiError.notFound("Conclave not found.");
    const patch = await fn(before);
    const [after] = await tx
      .update(conclaves)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conclaves.id, id))
      .returning();
    await audit.change(
      { action, entityType: "conclave", entityId: id, conclaveId: id, before: auditable(before), after: auditable(after), metadata },
      tx,
    );
    await notifyConclaveChanged(tx, id); // delivered to live listeners on commit
    return { before, after };
  });
}

// ---------------------------------------------------------------------------
// Validation and status rules (pure)
// ---------------------------------------------------------------------------

/** Validates the knobs the engine depends on. */
export function validateConfig(personsPerTable: number, roundCount: number) {
  if (!Number.isInteger(personsPerTable) || personsPerTable < MIN_PERSONS_PER_TABLE) {
    throw ApiError.badRequest(`personsPerTable must be a whole number of at least ${MIN_PERSONS_PER_TABLE}.`);
  }
  if (personsPerTable > MAX_PERSONS_PER_TABLE) {
    throw ApiError.badRequest(`A table seats at most ${MAX_PERSONS_PER_TABLE} people.`);
  }
  if (!Number.isInteger(roundCount) || roundCount < ROUND_LIMITS.min || roundCount > ROUND_LIMITS.max) {
    throw ApiError.badRequest(`roundCount must be between ${ROUND_LIMITS.min} and ${ROUND_LIMITS.max}.`);
  }
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === "function" ? maybe.toDate() : null;
}

/** Parses "09:00", "09:00 AM", "17:30" into hours and minutes. */
function parseTimeComponents(val: unknown): { hours: number; minutes: number } | null {
  if (!val) return null;
  if (typeof val === "string") {
    const match = val.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const meridian = match[3]?.toUpperCase();
      if (meridian === "PM" && h < 12) h += 12;
      if (meridian === "AM" && h === 12) h = 0;
      return { hours: h, minutes: m };
    }
  }
  const d = toDate(val);
  return d ? { hours: d.getHours(), minutes: d.getMinutes() } : null;
}

/** Date + "HH:mm", defaulting to start (00:00) or end (23:59:59.999) of day. */
function combineDateTime(base: Date | null, time: unknown, edge: "start" | "end"): Date | null {
  if (!base || Number.isNaN(base.getTime())) return null;
  const comp = parseTimeComponents(time);
  const d = new Date(base);
  if (comp) d.setHours(comp.hours, comp.minutes, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  else d.setHours(edge === "end" ? 23 : 0, edge === "end" ? 59 : 0, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  return d;
}

interface DateFields {
  date?: unknown; startDate?: unknown; endDate?: unknown; startTime?: unknown; endTime?: unknown;
  regStartDate?: unknown; regEndDate?: unknown; regStartTime?: unknown; regEndTime?: unknown;
}

/**
 * A nonsensical window (ends before it starts, registration open after the
 * event begins, a new event in the past) can never be saved.
 */
export function validateConclaveDates(d: DateFields, opts: { isNew: boolean }) {
  const now = new Date();
  const eventStart = combineDateTime(toDate(d.date) ?? toDate(d.startDate), d.startTime, "start");
  const eventEnd = combineDateTime(toDate(d.endDate) ?? toDate(d.date) ?? toDate(d.startDate), d.endTime, "end");
  const regStart = combineDateTime(toDate(d.regStartDate), d.regStartTime, "start");
  const regEnd = combineDateTime(toDate(d.regEndDate), d.regEndTime, "end");

  if (eventStart && eventEnd && eventEnd < eventStart) {
    throw ApiError.badRequest("The conclave can't end before it starts — check the event date and time.");
  }
  if (regStart && regEnd && regEnd <= regStart) {
    throw ApiError.badRequest("Registration must open before it closes.");
  }
  if (regEnd && eventStart && regEnd > eventStart) {
    throw ApiError.badRequest("Registration must close before the conclave starts — it can't stay open after the event has begun.");
  }
  if (opts.isNew && eventStart && eventStart < now) {
    throw ApiError.badRequest("The conclave can't start in the past.");
  }
}

/**
 * Status from the admin's choices (and the registration close time).
 *
 *  - completed / cancelled are final.
 *  - "running" only once the admin starts round 1 (never by the clock); it
 *    stays running until the admin marks it completed, or the last round's time
 *    is over (see autocomplete.service).
 *  - Registration closes when tables are generated or locked, when the admin
 *    switches it off, or at the optional close date & time.
 */
export function evaluateConclaveStatus(data: any): { status: string; isRegistrationOpen: boolean } {
  try {
    const statusLower = String(data?.status || "").trim().toLowerCase();
    if (statusLower === "completed") return { status: ConclaveStatus.completed, isRegistrationOpen: false };
    if (statusLower === "cancelled") return { status: ConclaveStatus.cancelled, isRegistrationOpen: false };
    if (statusLower === "running") return { status: ConclaveStatus.running, isRegistrationOpen: false };

    // Generating tables (or locking them) closes registration for good.
    if (data?.schedule || data?.isScheduleLocked || statusLower === "locked") {
      return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
    }

    const override = String(data?.registrationOverride ?? "").toLowerCase();
    if (override === "closed") return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
    if (override === "open") return { status: ConclaveStatus.registrationOpen, isRegistrationOpen: true };

    // "auto": open from the optional start, closed after the optional close time.
    const now = new Date();
    const regStart = combineDateTime(toDate(data?.regStartDate), data?.regStartTime, "start");
    const regEnd = combineDateTime(toDate(data?.regEndDate), data?.regEndTime, "end");
    if (regStart && now < regStart) return { status: ConclaveStatus.registrationNotOpen, isRegistrationOpen: false };
    if (regEnd && now > regEnd) return { status: ConclaveStatus.registrationClosed, isRegistrationOpen: false };
    return { status: ConclaveStatus.registrationOpen, isRegistrationOpen: true };
  } catch {
    return { status: data?.status || ConclaveStatus.registrationOpen, isRegistrationOpen: data?.isRegistrationOpen ?? true };
  }
}

export function normalizeTime(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^\d{1,2}:\d{2}/.test(trimmed)) return trimmed;
  }
  const d = toDate(val);
  if (d) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return typeof val === "string" ? val.trim() : null;
}

const ALL_STATUSES = new Set<string>(Object.values(ConclaveStatus));
const OVERRIDES = new Set(["auto", "open", "closed"]);

/** 60 / 120 / 300 seconds, or null if absent/invalid. */
function moveSecondsInput(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return (MOVE_SECONDS_OPTIONS as readonly number[]).includes(n) ? n : null;
}

function dateInput(v: unknown, field: string): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = toDate(v);
  if (!d) throw ApiError.badRequest(`${field} is not a valid date.`);
  return d;
}
function intInput(v: unknown, fallback: number, field: string): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest(`${field} must be a whole number.`);
  return n;
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export interface CreateInput {
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
  moveSeconds?: number;
  memberLimit?: number;
  captainLimit?: number;
  region?: string;
  paymentDetails?: Record<string, unknown>;
}

export async function createConclave(input: CreateInput): Promise<string> {
  const name = String(input.name ?? "").trim();
  const venueLocation = String(input.venueLocation ?? "").trim();
  if (!name || !venueLocation) throw ApiError.badRequest("name and venueLocation are required.");

  const defaults = await getConclaveDefaults();
  const personsPerTable = intInput(input.personsPerTable, defaults.personsPerTable, "personsPerTable");
  const roundCount = intInput(input.roundCount, defaults.roundCount, "roundCount");
  const moveSeconds = moveSecondsInput(input.moveSeconds) ?? DEFAULT_MOVE_SECONDS;
  validateConfig(personsPerTable, roundCount);
  validateConclaveDates(input, { isNew: true });

  const override = input.isRegistrationOpen === false ? "closed" : input.registrationOverride || "open";
  if (!OVERRIDES.has(override)) throw ApiError.badRequest("registrationOverride must be auto, open or closed.");
  if (input.status !== undefined && !ALL_STATUSES.has(input.status)) throw ApiError.badRequest("Unknown status.");

  const values = {
    name,
    venueLocation,
    region: input.region || "Global BNI Network",
    coordinator: input.coordinator || "",
    creator: input.creator || "",
    description: input.description || "",
    dateRange: input.dateRange || "",
    startDate: dateInput(input.date ?? input.startDate, "date") ?? new Date(),
    endDate: dateInput(input.endDate, "endDate"),
    regStartDate: dateInput(input.regStartDate, "regStartDate"),
    regEndDate: dateInput(input.regEndDate, "regEndDate"),
    regStartTime: normalizeTime(input.regStartTime),
    regEndTime: normalizeTime(input.regEndTime),
    startTime: normalizeTime(input.startTime),
    endTime: normalizeTime(input.endTime),
    registrationOverride: override,
    chiefGuests: Array.isArray(input.chiefGuests) ? input.chiefGuests : [],
    personsPerTable,
    roundCount,
    moveSeconds,
    roundExtensionSeconds: 0,
    memberLimit: intInput(input.memberLimit, 100, "memberLimit") || 100,
    captainLimit: intInput(input.captainLimit, 12, "captainLimit") || 12,
    paymentDetails: input.paymentDetails ?? null,
    registrationFee: input.paymentDetails?.registrationFee !== undefined ? Number(input.paymentDetails.registrationFee) || 0 : null,
  };
  const evaluated = evaluateConclaveStatus({ ...values, date: values.startDate });

  return pgdb.transaction(async (tx) => {
    const [row] = await tx
      .insert(conclaves)
      .values({ ...values, status: input.status || evaluated.status, isRegistrationOpen: evaluated.isRegistrationOpen })
      .returning();
    await audit.change({ action: "conclave.create", entityType: "conclave", entityId: row.id, after: auditable(row) }, tx);
    return row.id;
  });
}

export async function updateConclave(id: string, body: Record<string, any>): Promise<string[]> {
  const { before, after } = await mutate(id, "conclave.update", async (row) => {
    if (row.status === ConclaveStatus.running || row.status === ConclaveStatus.completed) {
      throw ApiError.conflict(`Cannot edit a conclave that is ${row.status}.`);
    }
    const u: ConclavePatch = {};
    const text = (k: keyof ConclavePatch, v: unknown) => { if (v !== undefined) (u as any)[k] = v === null ? null : String(v); };
    text("name", body.name);
    text("venueLocation", body.venueLocation);
    text("region", body.region);
    text("coordinator", body.coordinator);
    text("creator", body.creator);
    text("description", body.description);
    text("dateRange", body.dateRange);
    if (u.name !== undefined && !u.name?.trim()) throw ApiError.badRequest("Name can't be empty.");
    if (body.memberLimit !== undefined) u.memberLimit = intInput(body.memberLimit, 100, "memberLimit") || 100;
    if (body.captainLimit !== undefined) u.captainLimit = intInput(body.captainLimit, 12, "captainLimit") || 12;
    if (body.paymentDetails !== undefined) {
      u.paymentDetails = body.paymentDetails;
      if (body.paymentDetails?.registrationFee !== undefined) u.registrationFee = Number(body.paymentDetails.registrationFee) || 0;
    }
    if (body.chiefGuests !== undefined) u.chiefGuests = Array.isArray(body.chiefGuests) ? body.chiefGuests : [];
    if (body.date !== undefined || body.startDate !== undefined) u.startDate = dateInput(body.date ?? body.startDate, "date");
    if (body.endDate !== undefined) u.endDate = dateInput(body.endDate, "endDate");
    if (body.regStartDate !== undefined) u.regStartDate = dateInput(body.regStartDate, "regStartDate");
    if (body.regEndDate !== undefined) u.regEndDate = dateInput(body.regEndDate, "regEndDate");
    if (body.regStartTime !== undefined) u.regStartTime = normalizeTime(body.regStartTime);
    if (body.regEndTime !== undefined) u.regEndTime = normalizeTime(body.regEndTime);
    if (body.startTime !== undefined) u.startTime = normalizeTime(body.startTime);
    if (body.endTime !== undefined) u.endTime = normalizeTime(body.endTime);
    if (body.status !== undefined) {
      if (!ALL_STATUSES.has(body.status)) throw ApiError.badRequest("Unknown status.");
      u.status = body.status;
    }
    if (body.registrationOverride !== undefined) {
      const o = String(body.registrationOverride);
      if (!OVERRIDES.has(o)) throw ApiError.badRequest("registrationOverride must be auto, open or closed.");
      u.registrationOverride = o;
    } else if (body.isRegistrationOpen !== undefined) {
      u.registrationOverride = body.isRegistrationOpen ? "open" : "closed";
    }
    if (body.personsPerTable !== undefined || body.roundCount !== undefined) {
      if (row.schedule) {
        throw ApiError.conflict(
          "A schedule already exists. Changing persons-per-table or round count would invalidate it — regenerate the schedule instead.",
        );
      }
      const p = body.personsPerTable !== undefined ? Number(body.personsPerTable) : row.personsPerTable ?? NaN;
      const r = body.roundCount !== undefined ? Number(body.roundCount) : row.roundCount ?? NaN;
      validateConfig(p, r);
      u.personsPerTable = p;
      u.roundCount = r;
    }
    if (body.moveSeconds !== undefined) {
      const m = moveSecondsInput(body.moveSeconds);
      if (m === null) throw ApiError.badRequest("Move time must be 1, 2 or 5 minutes.");
      u.moveSeconds = m;
    }
    if (!Object.keys(u).length) throw ApiError.badRequest("Nothing to update.");

    // Validate and evaluate the RESULT of the edit, so a partial change that
    // creates a bad window is rejected.
    const merged = toView({ ...row, ...u } as ConclaveRow);
    validateConclaveDates(merged, { isNew: false });
    const evaluated = evaluateConclaveStatus(merged);
    if (body.status === undefined) u.status = evaluated.status;
    u.isRegistrationOpen = evaluated.isRegistrationOpen;
    return u;
  });
  void notifyConclaveDetailsUpdated(id, before, after).catch(() => {});
  return Object.keys(auditChanges(before, after));
}

function auditChanges(before: ConclaveRow, after: ConclaveRow) {
  const out: Record<string, true> = {};
  for (const k of Object.keys(after) as (keyof ConclaveRow)[]) {
    if (k === "updatedAt") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = true;
  }
  return out;
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
      changes.push(`Time updated to ${formatTime(newStartTime || "TBD")} - ${formatTime(newEndTime || "TBD")}`);
    }

    // 4. Venue change
    const oldVenue = String(oldData.venueLocation || oldData.venue || "").trim();
    const newVenue = updates.venueLocation !== undefined ? String(updates.venueLocation || "").trim() : (updates.venue !== undefined ? String(updates.venue || "").trim() : oldVenue);
    if ((updates.venueLocation !== undefined || updates.venue !== undefined) && newVenue !== oldVenue && newVenue) {
      changes.push(`Venue moved to ${newVenue}`);
    }

    // 5. Status change
    if (updates.status !== undefined && String(updates.status).toLowerCase() !== String(oldData.status || "").toLowerCase()) {
      const s = String(updates.status).toLowerCase();
      if (s === "cancelled") {
        changes.push("Event has been CANCELLED");
      } else if (s === "postponed") {
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

    // Each registered member: one push (their personal topic) + an inbox entry.
    // (Not also the conclave topic — that delivered every notice twice.)
    const attendees = await registrantsOf(conclaveId);
    for (const att of attendees) {
      const uid = att.userId;
      void notifyUser(uid, payload, "general").catch(() => { });
      void recordUserNotification(uid, payload).catch(() => { });
    }
  } catch (err) {
    console.error(`Failed to notify attendees for conclave ${conclaveId} updates:`, err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Open or close registration (two-way). */
export async function setRegistrationOpen(id: string, open: boolean) {
  await mutate(id, open ? "conclave.registration_open" : "conclave.registration_close", (row) => {
    if (TERMINAL_STATUSES.has(row.status) || row.status === ConclaveStatus.running) {
      throw ApiError.conflict(`Cannot change registration on a conclave that is ${row.status}.`);
    }
    const override = open ? "open" : "closed";
    const evaluated = evaluateConclaveStatus({ ...toView(row), registrationOverride: override });
    return { registrationOverride: override, isRegistrationOpen: evaluated.isRegistrationOpen, status: evaluated.status };
  });
}

/** Call a conclave off before it starts. */
export async function cancelConclave(id: string) {
  const { before } = await mutate(id, "conclave.cancel", (row) => {
    if (row.status === ConclaveStatus.completed) throw ApiError.conflict("A completed conclave cannot be cancelled.");
    if (row.status === ConclaveStatus.running) {
      throw ApiError.conflict(
        "This conclave is running — it cannot be cancelled. Use End Conclave to stop it now; members keep their attendance and referrals, and get their summaries.",
      );
    }
    if (row.status === ConclaveStatus.cancelled) throw ApiError.conflict("This conclave is already cancelled.");
    return { status: ConclaveStatus.cancelled, isRegistrationOpen: false, cancelledAt: new Date() };
  });
  void notifyConclaveDetailsUpdated(id, before, { status: "cancelled" }).catch(() => {});
}

/** Publish (lock) the schedule, then tell everyone. */
export async function lockConclaveSchedule(id: string) {
  await mutate(id, "conclave.lock_schedule", (row) => {
    if (!row.schedule) throw ApiError.badRequest("Generate a schedule before publishing it.");
    return {
      isScheduleLocked: true,
      isRegistrationOpen: false,
      registrationOverride: "closed",
      status: row.status === ConclaveStatus.completed ? ConclaveStatus.completed : ConclaveStatus.registrationClosed,
    };
  });
  // Best-effort: publishing is when members learn their schedule is ready and
  // captains which table they anchor.
  try {
    await notifyScheduleReady(id);
  } catch {}
}

async function registrantsOf(id: string) {
  return pgdb
    .select({ userId: registrations.userId, role: registrations.role, tableNumber: registrations.tableNumber })
    .from(registrations)
    .where(eq(registrations.conclaveId, id));
}

/** Personal push to every registrant: members "schedule ready", captains their table. */
export async function notifyScheduleReady(id: string): Promise<{ captains: number; members: number }> {
  let captains = 0;
  let members = 0;
  for (const r of await registrantsOf(id)) {
    try {
      if (r.role === "captain") {
        await notifyUser(
          r.userId,
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
          r.userId,
          { title: "Your conclave schedule is ready 📋", body: "Tap to view your table and who you'll be meeting.", data: { conclaveId: id, type: "schedule_ready" } },
          "general",
        );
        members++;
      }
    } catch {
      // one bad token must not stop the broadcast
    }
  }
  return { captains, members };
}

/** End the conclave. */
export async function completeConclave(id: string) {
  const { before } = await mutate(id, "conclave.complete", (row) => {
    if (row.status === ConclaveStatus.completed) throw ApiError.conflict("This conclave is already completed.");
    if (row.status !== ConclaveStatus.running) {
      throw ApiError.conflict(`Only a running conclave can be completed (this one is ${row.status}).`);
    }
    return { status: ConclaveStatus.completed, isRegistrationOpen: false, completedAt: new Date(), isRoundPaused: false, roundPausedAt: null };
  });

  const endedMsg = await resolveNotification("conclaveEnded");
  await notifyConclave(id, { title: endedMsg.title, body: endedMsg.body, data: { conclaveId: id, type: "conclave_completed" } });

  const finalRound = before.currentRound ?? 0;
  const roundCount = before.roundCount ?? 0;
  return { finalRound, roundCount, endedEarly: finalRound < roundCount };
}

/** Start a round (round 1 starts the conclave). */
export async function startRound(id: string, roundNumber: number, adminUid: string): Promise<Date> {
  if (!Number.isInteger(roundNumber) || roundNumber < 1) throw ApiError.badRequest("roundNumber must be a positive whole number.");
  const roundStartedAt = new Date();

  await mutate(
    id,
    roundNumber === 1 ? "conclave.start" : "round.start",
    async (row) => {
      if (roundNumber > (row.roundCount ?? 0)) throw ApiError.badRequest(`This conclave has only ${row.roundCount} rounds.`);
      if (TERMINAL_STATUSES.has(row.status)) throw ApiError.conflict(`This conclave is ${row.status}.`);

      // Rounds only move forward, one at a time: the next round may be started
      // early (even in automatic mode), but never one that already ran, and
      // never by skipping ahead.
      const live = liveClock(row);
      if (row.status === ConclaveStatus.running && roundNumber <= live.round) {
        throw ApiError.conflict(
          `Round ${roundNumber} has already started — the conclave is on round ${live.round}. Rounds can't be restarted.`,
          { liveRound: live.round },
        );
      }
      if (roundNumber > live.round + 1) {
        throw ApiError.badRequest(`Start round ${live.round + 1} next — rounds can't be skipped.`, { nextRound: live.round + 1 });
      }

      if (roundNumber === 1) {
        if (!row.schedule) throw ApiError.badRequest("No schedule has been generated. Generate one before starting round 1.");
        // One admin can't run two rooms at once.
        const [other] = await pgdb
          .select({ id: conclaves.id, name: conclaves.name })
          .from(conclaves)
          .where(and(eq(conclaves.status, ConclaveStatus.running), eq(conclaves.startedBy, adminUid), ne(conclaves.id, id)))
          .limit(1);
        if (other) {
          throw ApiError.conflict(
            `You are already running "${other.name}". End it before starting another — you cannot be in two rooms at once.`,
            { runningConclaveId: other.id },
          );
        }
      }

      return {
        status: ConclaveStatus.running,
        isRegistrationOpen: false,
        currentRound: roundNumber,
        currentRoundStartedAt: roundStartedAt,
        isRoundPaused: false,
        roundPausedAt: null,
        roundElapsedMsBeforePause: null,
        roundExtensionSeconds: 0,
        ...(roundNumber === 1 ? { startedBy: adminUid } : {}),
      };
    },
    { roundNumber },
  );

  try {
    const startedMsg = await resolveNotification("roundStarted", { round: roundNumber });
    const data = { conclaveId: id, roundNumber: String(roundNumber), type: "round_started" };
    await notifyConclave(id, { title: startedMsg.title, body: startedMsg.body, data });
    // Also each registrant's PERSONAL topic (subscribed on sign-in), since the
    // conclave topic is only subscribed on the active-round screen.
    for (const r of await registrantsOf(id)) {
      void notifyUser(r.userId, { title: startedMsg.title, body: startedMsg.body, data }, "round_alerts").catch(() => {});
    }
  } catch {}

  return roundStartedAt;
}

export async function pauseRound(id: string) {
  let result: { isRoundPaused: true; pausedAt: Date | null; elapsedMs?: number } | null = null;
  const { before } = await mutate(id, "round.pause", (row) => {
    if (row.status !== ConclaveStatus.running) throw ApiError.badRequest("Only a running conclave round can be paused.");
    if (row.isRoundPaused) {
      result = { isRoundPaused: true, pausedAt: row.roundPausedAt };
      return {};
    }
    const elapsedMs = row.currentRoundStartedAt ? Math.max(0, Date.now() - row.currentRoundStartedAt.getTime()) : 0;
    const pausedAt = new Date();
    result = { isRoundPaused: true, pausedAt, elapsedMs };
    return { isRoundPaused: true, roundPausedAt: pausedAt, roundElapsedMsBeforePause: elapsedMs };
  });
  if (!before.isRoundPaused) {
    try {
      await notifyConclave(id, {
        title: "Round Paused",
        body: `Round ${before.currentRound || 1} has been paused by the admin.`,
        data: { conclaveId: id, type: "round_paused" },
      });
    } catch {}
  }
  return result!;
}

export async function resumeRound(id: string) {
  let newStartedAt: Date | null = null;
  const { before, after } = await mutate(id, "round.resume", (row) => {
    if (row.status !== ConclaveStatus.running) throw ApiError.badRequest("Only a running conclave round can be resumed.");
    if (!row.isRoundPaused) return {};
    // New anchor = now minus the time already spent before the pause.
    newStartedAt = new Date(Date.now() - (row.roundElapsedMsBeforePause ?? 0));
    return { isRoundPaused: false, roundPausedAt: null, roundElapsedMsBeforePause: null, currentRoundStartedAt: newStartedAt };
  });
  if (!before.isRoundPaused) return { isRoundPaused: false, startedAt: after.currentRoundStartedAt };
  try {
    await notifyConclave(id, { title: "Round Resumed", body: `Round ${before.currentRound || 1} has resumed!`, data: { conclaveId: id, type: "round_resumed" } });
  } catch {}
  return { isRoundPaused: false, currentRoundStartedAt: newStartedAt };
}

/** Force-close the current round (or complete the conclave on the last round). */
export async function closeRound(id: string) {
  const { row } = await getConclaveOrThrow(id);
  if (row.status !== ConclaveStatus.running) throw ApiError.badRequest("Only a running conclave round can be closed.");
  const curRound = row.currentRound || 1;
  if (curRound >= (row.roundCount || 4)) return completeConclave(id);

  // End the round now: move its anchor back so its talk time (+ extension)
  // reads as just finished. Manual mode then waits for the admin; automatic
  // mode starts the move break from now.
  await mutate(
    id,
    "round.close",
    (r) => {
      if (r.status !== ConclaveStatus.running) throw ApiError.badRequest("Only a running conclave round can be closed.");
      const m = materialize(r);
      const ext = (m.roundExtensionSeconds ?? r.roundExtensionSeconds ?? 0) * 1000;
      const endedAnchor = new Date(Date.now() - phases(r).talkMs - ext);
      return { ...m, isRoundPaused: false, roundPausedAt: null, roundElapsedMsBeforePause: null, currentRoundStartedAt: endedAnchor };
    },
    { roundNumber: curRound },
  );
  try {
    await notifyConclave(id, {
      title: `Round ${curRound} Closed`,
      body: `Round ${curRound} has concluded.`,
      data: { conclaveId: id, type: "round_ended", roundNumber: String(curRound) },
    });
  } catch {}
  return { closedRound: curRound, isEnded: true };
}

/**
 * Manual ⇄ automatic, at any time (even mid-conclave). The clock is first
 * pinned to the round it is actually on, so nothing jumps:
 *  - automatic → manual: the round in progress stays; later rounds wait.
 *  - manual → automatic while a finished round is waiting: the move break
 *    starts now (not back when that round ended).
 */
export async function setProgressionMode(id: string, mode: string): Promise<string> {
  const normMode = mode === "automatic" ? "automatic" : "manual";
  await mutate(
    id,
    "conclave.set_progression_mode",
    (row) => {
      if (TERMINAL_STATUSES.has(row.status)) throw ApiError.conflict(`This conclave is ${row.status}.`);
      if ((row.roundProgressionMode ?? "manual") === normMode) return {};
      const patch: ConclavePatch = { ...materialize(row), roundProgressionMode: normMode };
      if (normMode === "automatic" && row.status === ConclaveStatus.running && !row.isRoundPaused) {
        const live = liveClock(row);
        if (live.phase === "waiting") {
          const ext = (row.roundExtensionSeconds ?? 0) * 1000;
          patch.currentRoundStartedAt = new Date(Date.now() - phases(row).talkMs - ext);
        }
      }
      return patch;
    },
    { mode: normMode },
  );
  return normMode;
}

/**
 * Extra time for the round in progress (+1 / +2 / +5 min), added AFTER the
 * referral slot — bios and referrals keep their fixed times. For rare cases
 * where tables want longer one-to-ones.
 */
export async function extendRound(id: string, additionalSeconds: number): Promise<{ ok: boolean; roundExtensionSeconds: number }> {
  if (!(EXTEND_SECONDS_OPTIONS as readonly number[]).includes(additionalSeconds)) {
    throw ApiError.badRequest("A round can be extended by 1, 2 or 5 minutes.");
  }
  let total = 0;
  await mutate(
    id,
    "round.extend",
    (row) => {
      if (row.status !== ConclaveStatus.running) throw ApiError.conflict(`Only a running conclave's round can be extended.`);
      const m = materialize(row);
      const pinned = { ...row, ...m } as ConclaveRow;
      const live = liveClock(pinned);
      if (!["bio", "referral", "extension"].includes(live.phase)) {
        throw ApiError.conflict("Extend a round while it is in progress — this one has already finished.");
      }
      total = (pinned.roundExtensionSeconds ?? 0) + additionalSeconds;
      if (total > MAX_EXTENSION_SECONDS) {
        throw ApiError.badRequest(`A round can be extended by at most ${MAX_EXTENSION_SECONDS / 60} minutes in total.`);
      }
      return { ...m, roundExtensionSeconds: total };
    },
    { addedSeconds: additionalSeconds },
  );
  return { ok: true, roundExtensionSeconds: total };
}

/** Automatic mode's break between rounds: 1, 2 or 5 minutes. */
export async function setMoveSeconds(id: string, seconds: number): Promise<{ ok: boolean; moveSeconds: number }> {
  const m = moveSecondsInput(seconds);
  if (m === null) throw ApiError.badRequest("Move time must be 1, 2 or 5 minutes.");
  await mutate(
    id,
    "conclave.set_move_time",
    (row) => {
      if (TERMINAL_STATUSES.has(row.status)) throw ApiError.conflict(`This conclave is ${row.status}.`);
      // Pin first, so changing the break doesn't renumber rounds already reached.
      return { ...materialize(row), moveSeconds: m };
    },
    { moveSeconds: m },
  );
  return { ok: true, moveSeconds: m };
}

// ---------------------------------------------------------------------------
// Listing and deletion
// ---------------------------------------------------------------------------

/** "Guntur Region" and "guntur" compare equal. */
export const normRegion = (r: unknown) => String(r ?? "").toLowerCase().replace(/\s+region$/, "").trim();

/**
 * Every conclave (optionally one region's), newest first, with registration
 * counts and a status recomputed from the clock.
 */
export async function listConclaves(region?: string): Promise<ConclaveView[]> {
  const rows = await pgdb
    .select({ row: conclaves, regCount: sql<number>`(SELECT count(*)::int FROM ${registrations} r WHERE r.conclave_id = ${conclaves.id})` })
    .from(conclaves)
    .orderBy(desc(conclaves.startDate));

  const target = region ? normRegion(region) : "";
  const out: ConclaveView[] = [];
  const fixes: { id: string; status: string; isRegistrationOpen: boolean }[] = [];

  for (const { row, regCount } of rows) {
    if (target && normRegion(row.region) !== target) continue;

    const count = regCount > 0 ? regCount : Array.isArray(row.participants) ? row.participants.length : 0;
    let effective = row;

    // Self-heal a "completed" that no admin set and no round ran (completedAt
    // empty, currentRound 0) — recompute from the window, but never re-open a
    // conclave whose day has genuinely passed.
    if (row.status === ConclaveStatus.completed && !row.currentRound && !row.completedAt) {
      const e = evaluateConclaveStatus({ ...toView(row), status: undefined });
      if (e.status !== ConclaveStatus.completed) {
        effective = { ...row, status: e.status, isRegistrationOpen: e.isRegistrationOpen };
        fixes.push({ id: row.id, status: e.status, isRegistrationOpen: e.isRegistrationOpen });
      }
    } else if (!TERMINAL_STATUSES.has(row.status)) {
      const e = evaluateConclaveStatus(toView(row));
      effective = { ...row, status: e.status, isRegistrationOpen: e.isRegistrationOpen };
    }
    out.push(toView(effective, count));
  }

  // Persist self-heal corrections (audited as automatic fixes), best-effort.
  for (const f of fixes) {
    void mutate(f.id, "conclave.status_autofix", () => ({ status: f.status, isRegistrationOpen: f.isRegistrationOpen })).catch(() => {});
  }
  return out;
}

export async function deleteConclave(id: string) {
  await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(conclaves).where(eq(conclaves.id, id)).for("update");
    if (!before) throw ApiError.notFound(`Conclave with ID "${id}" does not exist.`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(registrations).where(eq(registrations.conclaveId, id));
    // Registrations, attendance, referrals and feedback cascade with it.
    await tx.delete(conclaves).where(eq(conclaves.id, id));
    await audit.change(
      { action: "conclave.delete", entityType: "conclave", entityId: id, conclaveId: id, before: auditable(before), after: null, metadata: { registrations: n } },
      tx,
    );
  });
}

/** Running conclaves (for the auto-complete sweep). */
export async function listRunning() {
  return pgdb.select().from(conclaves).where(inArray(conclaves.status, [ConclaveStatus.running]));
}
export { mutate as mutateConclave };

/**
 * uids of everyone who shares a table with `uid` in any round of `schedule`
 * (the people a member actually met — whose contact details they may see).
 */
function tablemateUids(schedule: any, participants: Record<string, unknown>[], uid: string): Set<string> {
  const me = participants.find((p) => p._originalUid === uid)?.id;
  const out = new Set<string>();
  if (me === undefined || !Array.isArray(schedule?.rounds)) return out;
  const uidOf = new Map(participants.map((p) => [p.id, String(p._originalUid ?? "")]));
  for (const round of schedule.rounds) {
    for (const t of round?.tables ?? []) {
      const seats = [t.captainId, ...(t.memberIds ?? [])];
      if (!seats.includes(me)) continue;
      for (const pid of seats) if (pid !== me) out.add(uidOf.get(pid) ?? "");
    }
  }
  out.delete("");
  return out;
}

/**
 * The member-facing conclave list: every conclave, flagged with THIS member's
 * registration (role, table). In the seating list, phone numbers are kept only
 * for people the member shared a table with ("People I met" → save contact);
 * everyone else's are removed.
 */
export async function listForMember(uid: string, email?: string) {
  const [all, mine] = await Promise.all([
    listConclaves(),
    (async () => {
      const [u] = await pgdb.select({ email: users.email, phone: users.phone }).from(users).where(eq(users.uid, uid));
      const e = (u?.email || email || "").toLowerCase().trim();
      const conditions = [eq(registrations.userId, uid)];
      if (e) conditions.push(sql`lower(${registrations.email}) = ${e}`);
      if (u?.phone) conditions.push(eq(registrations.phone, u.phone));
      return pgdb
        .select({ id: registrations.conclaveId, role: registrations.role, tableNumber: registrations.tableNumber })
        .from(registrations)
        .where(or(...conditions));
    })(),
  ]);
  const regBy = new Map(mine.map((r) => [r.id, r]));
  return all.map((c) => {
    const parts = Array.isArray(c.participants) ? (c.participants as Record<string, unknown>[]) : null;
    const met = parts ? tablemateUids(c.schedule, parts, uid) : new Set<string>();
    const reg = regBy.get(c.id);
    return {
      ...c,
      participants: parts
        ? parts.map(({ phone, ...p }) => (met.has(String(p._originalUid)) || p._originalUid === uid ? { ...p, phone } : p))
        : c.participants,
      isRegistered: !!reg,
      myRole: reg?.role ?? null,
      myTableNumber: reg?.tableNumber ?? null,
    };
  });
}

/**
 * Attach (or clear) a conclave's agenda document. The file is stored first; the
 * conclave change is then audited; the previous file is deleted afterwards.
 */
export async function setAgenda(
  id: string,
  input: { dataUrl?: string; url?: string; name?: string; rawText?: string; agendaText?: string } | null,
) {
  const { row } = await getConclaveOrThrow(id);
  let record: Record<string, unknown> | null = null;

  if (input) {
    const name = String(input.name || "agenda.pdf").slice(0, 120);
    let stored: StoredFile | null = null;
    if (input.dataUrl?.startsWith("data:")) {
      const { contentType, data } = decodeDataUrl(input.dataUrl);
      stored = await uploadFile("agendas", name, contentType, data);
    } else if (!input.url && !input.rawText && !input.agendaText) {
      throw ApiError.badRequest("Send the agenda as a file (data URL) or as text.");
    }
    const text = String(input.agendaText || input.rawText || "").slice(0, 20_000);
    record = {
      name,
      url: stored?.url ?? input.url ?? "",
      storagePath: stored?.path ?? "",
      type: stored?.contentType ?? "application/pdf",
      bytes: stored?.bytes ?? 0,
      agendaText: text,
      rawText: text,
      uploadedAt: new Date().toISOString(),
    };
  }

  await mutate(id, record ? "conclave.agenda_set" : "conclave.agenda_clear", () => ({ agendaDocument: record }));
  const previous = (row.agendaDocument as { storagePath?: string } | null)?.storagePath;
  if (previous && previous !== record?.storagePath) await deleteFile(previous);
  return record;
}

/** One conclave for a member: full detail (schedule included), contacts stripped. */
export async function getForMember(id: string, uid: string, email?: string) {
  const all = await listForMember(uid, email);
  const found = all.find((c) => c.id === id);
  if (!found) throw ApiError.notFound("Conclave not found.");
  return found;
}
