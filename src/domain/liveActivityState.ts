/**
 * What a member's iOS Live Activity (the lock-screen round card) should show
 * right now — computed on the server so it can be PUSHED while the app is
 * suspended. Must match the app's `RoundActivityAttributes.RoundState`
 * (ios/ConclaveWidgets/RoundActivityAttributes.swift): same keys, same types.
 *
 * The server works at phase level (introductions, referrals, extra time, move,
 * waiting, paused). Per-speaker detail ("Now: Asha") stays with the app while
 * it is open; a push only lands when something the member must act on changes.
 *
 * Pure — no database, so it is unit-tested.
 */

import { liveClock, phases, type ClockRow } from "./roundClock.js";

export interface LiveActivityContent {
  round: number;
  totalRounds: number;
  tableNumber: number;
  line: string;
  /** Seconds since 1970 when the card's countdown reaches zero. */
  segmentEndEpoch: number;
  paused: boolean;
}

export type LiveActivityUpdate =
  | { event: "update"; content: LiveActivityContent }
  | { event: "end"; content: LiveActivityContent };

interface Table {
  tableNumber: number;
  captainId: number | null;
  memberIds: number[];
}
interface Round {
  roundNumber: number;
  tables: Table[];
}

export interface LiveActivityRow extends ClockRow {
  status: string;
  schedule: { rounds?: Round[] } | null;
  participants: Array<{ id: number; _originalUid: string }> | null;
}

/** A conclave-wide key: when it changes, every card needs a push. */
export function liveActivityKey(row: LiveActivityRow, now = Date.now()): string {
  if (row.status !== "running") return `status:${row.status}`;
  const c = liveClock(row, now);
  return [c.round, c.phase, row.isRoundPaused ? 1 : 0, Number(row.roundExtensionSeconds) || 0].join("|");
}

function tableOf(row: LiveActivityRow, round: number, pid: number): Table | undefined {
  return row.schedule?.rounds
    ?.find((r) => r.roundNumber === round)
    ?.tables.find((t) => t.captainId === pid || t.memberIds.includes(pid));
}

/** The update for one member, or null if they aren't seated in this conclave. */
export function liveActivityFor(row: LiveActivityRow, uid: string, now = Date.now()): LiveActivityUpdate | null {
  const pid = row.participants?.find((p) => p._originalUid === uid)?.id;
  if (pid === undefined) return null;
  const total = Number(row.roundCount) || 0;
  const c = liveClock(row, now);
  const round = Math.max(1, c.round);
  const here = tableOf(row, round, pid);
  const next = round < total ? tableOf(row, round + 1, pid) : undefined;
  const base = {
    round,
    totalRounds: total,
    tableNumber: here?.tableNumber ?? 0,
    paused: Boolean(row.isRoundPaused),
  };
  const sec = (ms: number) => Math.round(ms) / 1000;

  if (row.status !== "running" || c.phase === "done") {
    return {
      event: "end",
      content: { ...base, line: row.status === "cancelled" ? "Conclave cancelled" : "That's a wrap", segmentEndEpoch: sec(now), paused: false },
    };
  }
  if (c.phase === "not_started" || c.roundStartMs === null) return null;

  const ext = c.round === (Number(row.currentRound) || 0) ? (Number(row.roundExtensionSeconds) || 0) * 1000 : 0;
  const talkEnds = c.roundStartMs + phases(row).talkMs + ext;
  const captainHere = here?.captainId === pid;

  switch (c.phase) {
    case "bio":
      return { event: "update", content: { ...base, line: "Introductions · 1 min each", segmentEndEpoch: sec(talkEnds) } };
    case "referral":
      return { event: "update", content: { ...base, line: "Referral round · pass your leads", segmentEndEpoch: sec(talkEnds) } };
    case "extension":
      return { event: "update", content: { ...base, line: "Extra time · one-to-ones", segmentEndEpoch: sec(talkEnds) } };
    case "move":
    case "waiting": {
      const n = next?.tableNumber;
      const line =
        n === undefined
          ? "Round over"
          : captainHere && n === here?.tableNumber
            ? `Stay at Table ${n} · your next group is arriving`
            : `Move to Table ${n}`;
      return {
        event: "update",
        content: { ...base, line, segmentEndEpoch: sec(c.phaseEndsMs ?? now) },
      };
    }
  }
  return null;
}
