// Rules about WHEN a conclave happens, and what that forbids.
//
// Kept out of index.ts so they can be unit-tested without booting Express or
// touching Firestore.

/** A Firestore Timestamp, a Date, or nothing. */
type MaybeTime = { toDate?: () => Date } | Date | string | null | undefined;

function asDate(v: MaybeTime): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === "function" ? maybe.toDate() : null;
}

function parseTimeParts(val: unknown): { hours: number; minutes: number } | null {
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
  const d = asDate(val as MaybeTime);
  if (d && !isNaN(d.getTime())) {
    return { hours: d.getHours(), minutes: d.getMinutes() };
  }
  return null;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * The window a conclave occupies.
 *
 * Correctly combines event date with startTime and endTime if provided,
 * allowing non-overlapping same-day conclaves (e.g. morning and afternoon).
 * Falls back to whole-day boundaries only when times are unspecified.
 */
export function conclaveWindow(c: {
  date?: MaybeTime;
  startDate?: MaybeTime;
  endDate?: MaybeTime;
  regStartDate?: MaybeTime;
  regEndDate?: MaybeTime;
  startTime?: unknown;
  endTime?: unknown;
}): TimeWindow | null {
  const directStart = asDate(c.startDate) ?? asDate(c.date);
  const directEnd = asDate(c.endDate) ?? directStart;

  const baseDate = directStart ?? asDate(c.date) ?? asDate(c.regEndDate) ?? asDate(c.regStartDate);
  if (!baseDate) return null;

  const startParts = parseTimeParts(c.startTime);
  const endParts = parseTimeParts(c.endTime);

  const start = new Date(directStart ?? baseDate);
  if (startParts) {
    start.setHours(startParts.hours, startParts.minutes, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0);
  }

  const end = new Date(directEnd ?? baseDate);
  if (endParts) {
    end.setHours(endParts.hours, endParts.minutes, 0, 0);
  } else {
    end.setHours(23, 59, 59, 999);
  }

  if (end <= start) {
    end.setTime(start.getTime() + 2 * 60 * 60 * 1000);
  }

  return { start, end };
}

/**
 * Do two windows overlap?
 *
 * Half-open: a conclave ending at 11:00 and another starting at 11:00 do NOT
 * clash. Back-to-back events are legitimate; treating them as a conflict would
 * stop someone attending a morning and an afternoon conclave on the same day,
 * which the spec explicitly allows.
 */
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}
