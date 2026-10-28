/**
 * The round clock — one source of truth for "which round is it, and which
 * part of the round", shared by the live stream, referral sync, auto-complete
 * and the admin controls. The phone app and the admin panel mirror these rules.
 *
 * Rules (confirmed by the organisers, 2026-10-28):
 *
 *  - A table seats at most 8 people. Every table follows ONE clock, sized by
 *    the conclave's people-per-table (the largest table).
 *  - A round = everyone's 1-minute bio, then ONE shared referral slot of
 *    30 seconds per person:   P = 8 →  bios 0–8 min, referrals 8–12 min.
 *    Bio and referral times are fixed; they are not settings.
 *  - Referrals are accepted only during the referral slot.
 *  - The admin may extend a live round (+1 / +2 / +5 min). The extra time is
 *    added AFTER the referral slot (free time for one-to-ones); bios and the
 *    referral slot never move.
 *  - Progression is "manual" by default: the admin starts every round, and a
 *    finished round waits. In "automatic" mode, after a round (and any
 *    extension) a move break of 1 / 2 / 5 min follows (chosen per conclave),
 *    then the next round starts by itself. The mode can be switched at any
 *    time, even while the conclave runs.
 *  - Pausing freezes the clock.
 */

export const BIO_MS_PER_PERSON = 60_000;
export const REFERRAL_MS_PER_PERSON = 30_000;
export const MAX_PERSONS_PER_TABLE = 8;
export const MOVE_SECONDS_OPTIONS = [60, 120, 300] as const;
export const DEFAULT_MOVE_SECONDS = 120;
export const EXTEND_SECONDS_OPTIONS = [60, 120, 300] as const;
/** A round can be stretched by at most this much in total. */
export const MAX_EXTENSION_SECONDS = 15 * 60;

export type ProgressionMode = "manual" | "automatic";
export type Phase = "not_started" | "bio" | "referral" | "extension" | "move" | "waiting" | "done";

export interface ClockRow {
  currentRound: number | null;
  currentRoundStartedAt: Date | null;
  roundCount: number | null;
  personsPerTable: number | null;
  roundProgressionMode?: string | null;
  roundExtensionSeconds?: number | null;
  moveSeconds?: number | null;
  isRoundPaused?: boolean | null;
  roundElapsedMsBeforePause?: number | null;
}

const people = (row: Pick<ClockRow, "personsPerTable">) =>
  Math.min(MAX_PERSONS_PER_TABLE, Math.max(1, Number(row.personsPerTable) || 1));

export const isAutomatic = (row: Pick<ClockRow, "roundProgressionMode">) => row.roundProgressionMode === "automatic";

/** Lengths of the parts of a round, in ms. */
export function phases(row: Pick<ClockRow, "personsPerTable">) {
  const p = people(row);
  const bioMs = p * BIO_MS_PER_PERSON;
  const referralMs = p * REFERRAL_MS_PER_PERSON;
  return { bioMs, referralMs, talkMs: bioMs + referralMs };
}

const moveMs = (row: ClockRow) => Math.max(0, Number(row.moveSeconds ?? DEFAULT_MOVE_SECONDS)) * 1000;
const extMs = (row: ClockRow) => Math.max(0, Number(row.roundExtensionSeconds) || 0) * 1000;

/** "Now" for the clock: frozen at the pause point while paused. */
export function clockNow(row: ClockRow, now = Date.now()): number {
  if (row.isRoundPaused && row.currentRoundStartedAt) {
    return row.currentRoundStartedAt.getTime() + Math.max(0, Number(row.roundElapsedMsBeforePause) || 0);
  }
  return now;
}

/**
 * When round `k` starts (ms), or null if it hasn't been / won't be started by
 * the clock. The current round is the anchor; in automatic mode later rounds
 * follow after the current round (with its extension) + move, then each later
 * round's talk time + move. The extension belongs to the current round only.
 */
export function roundStartMs(row: ClockRow, k: number): number | null {
  const cur = Number(row.currentRound) || 0;
  if (!row.currentRoundStartedAt || cur < 1 || k < cur) return null;
  const anchor = row.currentRoundStartedAt.getTime();
  if (k === cur) return anchor;
  if (!isAutomatic(row)) return null;
  const { talkMs } = phases(row);
  return anchor + (talkMs + extMs(row) + moveMs(row)) + (k - cur - 1) * (talkMs + moveMs(row));
}

/** When round `k`'s talking (+ extension, for the current round) ends. */
export function roundEndMs(row: ClockRow, k: number): number | null {
  const start = roundStartMs(row, k);
  if (start === null) return null;
  return start + phases(row).talkMs + (k === (Number(row.currentRound) || 0) ? extMs(row) : 0);
}

/** The referral slot of round `k` (ms), or null if that round has no start yet. */
export function referralSlot(row: ClockRow, k: number): { opens: number; closes: number } | null {
  const start = roundStartMs(row, k);
  if (start === null) return null;
  const { bioMs, referralMs } = phases(row);
  return { opens: start + bioMs, closes: start + bioMs + referralMs };
}

export interface LiveClock {
  /** The round in progress (or the last one reached). 0 before round 1. */
  round: number;
  phase: Phase;
  roundStartMs: number | null;
  /** When the current phase ends (null when it waits for the admin). */
  phaseEndsMs: number | null;
}

/** Where the conclave is right now. */
export function liveClock(row: ClockRow, now = Date.now()): LiveClock {
  const cur = Number(row.currentRound) || 0;
  const total = Number(row.roundCount) || 0;
  if (cur < 1 || !row.currentRoundStartedAt) return { round: 0, phase: "not_started", roundStartMs: null, phaseEndsMs: null };
  const t = clockNow(row, now);
  const { bioMs, talkMs } = phases(row);

  let k = cur;
  // Automatic mode: walk forward through rounds the clock has started.
  if (isAutomatic(row)) {
    while (k < total) {
      const next = roundStartMs(row, k + 1)!;
      if (t < next) break;
      k++;
    }
  }
  const start = roundStartMs(row, k)!;
  const ext = k === cur ? extMs(row) : 0;
  const into = t - start;
  if (into < bioMs) return { round: k, phase: "bio", roundStartMs: start, phaseEndsMs: start + bioMs };
  if (into < talkMs) return { round: k, phase: "referral", roundStartMs: start, phaseEndsMs: start + talkMs };
  if (into < talkMs + ext) return { round: k, phase: "extension", roundStartMs: start, phaseEndsMs: start + talkMs + ext };
  if (k >= total) return { round: k, phase: "done", roundStartMs: start, phaseEndsMs: null };
  if (isAutomatic(row)) {
    return { round: k, phase: "move", roundStartMs: start, phaseEndsMs: start + talkMs + ext + moveMs(row) };
  }
  return { round: k, phase: "waiting", roundStartMs: start, phaseEndsMs: null };
}

/**
 * Rewrite the stored anchor so it names the round the clock is actually on —
 * needed before switching mode or extending, so the virtual rounds of
 * automatic mode don't jump. Returns the fields to store (or {} if nothing
 * changes).
 */
export interface PinnedClock {
  currentRound?: number;
  currentRoundStartedAt?: Date;
  roundExtensionSeconds?: number;
  roundElapsedMsBeforePause?: number;
}

export function materialize(row: ClockRow, now = Date.now()): PinnedClock {
  const live = liveClock(row, now);
  const cur = Number(row.currentRound) || 0;
  if (live.round > cur && live.roundStartMs !== null) {
    return {
      currentRound: live.round,
      currentRoundStartedAt: new Date(live.roundStartMs),
      roundExtensionSeconds: 0,
      // While paused, the frozen point is kept relative to the new anchor.
      ...(row.isRoundPaused ? { roundElapsedMsBeforePause: clockNow(row, now) - live.roundStartMs } : {}),
    };
  }
  return {};
}
