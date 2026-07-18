/**
 * The conclave lifecycle, and the rules that hang off it.
 */

export const ConclaveStatus = {
  /** Created, but the admin has not opened the doors yet. This is the default. */
  registrationNotOpen: "registrationNotOpen",
  registrationOpen: "registrationOpen",
  registrationClosed: "registrationClosed",
  running: "running",
  completed: "completed",
  cancelled: "cancelled",
} as const;

export type ConclaveStatusValue =
  (typeof ConclaveStatus)[keyof typeof ConclaveStatus];

/**
 * Roles freeze once the conclave starts.
 *
 * The schedule has already been generated and handed to every phone by then;
 * changing who anchors a table afterwards would leave the app and the room
 * disagreeing about where people should sit.
 */
export const ROLE_LOCKED_STATUSES: ReadonlySet<string> = new Set([
  ConclaveStatus.running,
  ConclaveStatus.completed,
  ConclaveStatus.cancelled,
]);

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ConclaveStatus.completed,
  ConclaveStatus.cancelled,
]);

/** The engine's limits. A conclave outside these cannot be scheduled. */
export const ROUND_LIMITS = { min: 4, max: 8 } as const;
export const MIN_PERSONS_PER_TABLE = 2;

/**
 * Round timing.
 *
 * A round occupies a fixed 15-minute block. The active (talking) portion is
 * 1.5 minutes per person at the table; whatever is left of the block is the
 * transition window for members to walk to their next table.
 *
 *   P = 8 -> 12 min talking + 3 min transition
 *   P = 6 ->  9 min talking + 6 min transition
 *
 * A table big enough to consume the whole block leaves no transition time; we
 * clamp at zero rather than produce a negative window.
 */
export const ROUND_BLOCK_MS = 15 * 60_000;
export const MS_PER_PERSON = 90_000;

export interface RoundTiming {
  activeMs: number;
  transitionMs: number;
}

export function roundTiming(personsPerTable: number): RoundTiming {
  const p = Math.max(1, personsPerTable);
  const activeMs = Math.min(p * MS_PER_PERSON, ROUND_BLOCK_MS);
  return { activeMs, transitionMs: Math.max(0, ROUND_BLOCK_MS - activeMs) };
}
