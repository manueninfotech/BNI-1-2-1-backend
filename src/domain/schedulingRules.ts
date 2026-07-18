// Rules about WHEN a conclave happens, and what that forbids.
//
// Kept out of index.ts so they can be unit-tested without booting Express or
// touching Firestore.

/** A Firestore Timestamp, a Date, or nothing. */
type MaybeTime = { toDate?: () => Date } | Date | null | undefined;

function asDate(v: MaybeTime): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  return typeof v.toDate === "function" ? v.toDate() : null;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * The window a conclave occupies.
 *
 * start/end are optional by design — the spec calls them "flexible". When they
 * are missing we cannot PROVE two conclaves don't overlap, so the conclave is
 * treated as occupying its whole day. That is deliberately conservative: it can
 * block a same-day registration that would in fact have been fine, which is far
 * better than letting someone commit to two events they cannot both attend.
 */
export function conclaveWindow(c: {
  date?: MaybeTime;
  startTime?: MaybeTime;
  endTime?: MaybeTime;
}): TimeWindow | null {
  const start = asDate(c.startTime);
  const end = asDate(c.endTime);

  if (start && end) return { start, end };

  const date = asDate(c.date) ?? start;
  if (!date) return null;

  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  // Only a start is known: from then until the end of that day.
  if (start && !end) return { start, end: dayEnd };

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  return { start: dayStart, end: dayEnd };
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
