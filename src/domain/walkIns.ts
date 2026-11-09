/**
 * Walk-ins: seating people who join a conclave after it has started.
 *
 * Organisers' rules (2026-11-10):
 *   - A walk-in always joins from a FUTURE round, never mid-round.
 *   - A registered member's seat is never given away (they may still arrive).
 *   - Tables stay balanced (sizes differ by at most one, never above P). While
 *     there is room, walk-ins fill it; once every table is full, a new table
 *     opens and the remaining rounds are re-planned so everyone stays even.
 *   - In a captain conclave a new table needs a captain the admin picks.
 *
 * Re-planning only touches rounds from `fromRound` on; every earlier round
 * (played, or already being walked to) is kept exactly as it was, and the
 * people who met in them count as "already met" so the new plan avoids repeats.
 *
 * Pure: no database, so the rules are unit-testable.
 */

import { auditSchedule, planSchedule, type PlanTable, type RoundSeating, type Schedule } from "../engine/index.js";
import type { ServerParticipant } from "./captains.js";
import { liveClock, type ClockRow } from "./roundClock.js";

/** The first round a walk-in approved now can join, or null when none is left. */
export function joinsFromRound(row: ClockRow & { roundCount?: number | null }, now = Date.now()): number | null {
  const total = Number(row.roundCount) || 0;
  const live = liveClock(row, now);
  let first: number;
  switch (live.phase) {
    case "not_started":
      first = 1;
      break;
    case "bio":
    case "referral":
    case "extension":
      // Tables are talking: seat them from the next round.
      first = live.round + 1;
      break;
    default:
      // Move break / waiting for the admin: people are already heading to the
      // next round's tables, so that round stays as planned.
      first = live.round + 2;
  }
  return first <= total ? first : null;
}

export class WalkInPlanError extends Error {
  constructor(
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WalkInPlanError";
  }
}

export interface WalkInPlanInput {
  schedule: Schedule;
  participants: ServerParticipant[];
  newcomers: ServerParticipant[];
  personsPerTable: number;
  roundCount: number;
  seed: number;
  captainless: boolean;
  fromRound: number;
  /** Participant ids to anchor any NEW tables (captain conclaves only). */
  newTableCaptainIds?: number[];
}

export interface WalkInPlan {
  schedule: Schedule;
  participants: ServerParticipant[];
  /** Table numbers opened by this plan. */
  tablesAdded: number[];
  /** uid -> new table number, for everyone whose table in `fromRound` changed. */
  moved: Map<string, number>;
}

/** How many new tables seating everyone needs (0 while there is room). */
export function tablesNeeded(currentTables: number, people: number, personsPerTable: number): number {
  return Math.max(0, Math.ceil(people / personsPerTable) - currentTables);
}

export function planWithWalkIns(input: WalkInPlanInput): WalkInPlan {
  const { schedule, personsPerTable: P, fromRound } = input;
  if (fromRound < 1 || fromRound > input.roundCount) {
    throw new WalkInPlanError("There are no rounds left to join.");
  }
  const everyone = [...input.participants, ...input.newcomers];

  // The table layout (numbers and anchors) is the same every round.
  const layout: PlanTable[] = (schedule.rounds.find((r) => r.roundNumber === fromRound) ?? schedule.rounds[0]).tables.map(
    (t) => ({ tableNumber: t.tableNumber, captainId: input.captainless ? null : t.captainId }),
  );

  const add = tablesNeeded(layout.length, everyone.length, P);
  const tablesAdded: number[] = [];
  if (add > 0) {
    const anchors = new Set(layout.map((t) => t.captainId).filter((x): x is number => x !== null));
    const picks = input.captainless ? [] : (input.newTableCaptainIds ?? []).filter((id) => !anchors.has(id));
    if (!input.captainless && picks.length < add) {
      throw new WalkInPlanError(
        add === 1
          ? "Every table is full, so a new table opens. Pick its captain."
          : `Every table is full, so ${add} new tables open. Pick a captain for each.`,
        { needsCaptains: add },
      );
    }
    let next = Math.max(...layout.map((t) => t.tableNumber)) + 1;
    for (let i = 0; i < add; i++) {
      const captainId = input.captainless ? null : picks[i];
      if (captainId !== null && !everyone.some((p) => p.id === captainId)) {
        throw new WalkInPlanError("The chosen captain isn't part of this conclave.");
      }
      layout.push({ tableNumber: next, captainId });
      tablesAdded.push(next);
      next++;
    }
  }

  // Organisers' minimum: no table below 3.
  if (Math.floor(everyone.length / layout.length) < 3) {
    throw new WalkInPlanError("Seating everyone would leave a table with fewer than 3 people.");
  }

  const history: RoundSeating[] = schedule.rounds.filter((r) => r.roundNumber < fromRound);
  const planned = planSchedule({
    participants: everyone,
    tables: layout,
    config: { ...schedule.config, personsPerTable: P, roundCount: input.roundCount, seed: input.seed, tableCount: layout.length, captainless: input.captainless },
    history,
    fromRound,
  });

  // Independent check of every re-planned round before anything is saved: no
  // category clash, nobody seated twice or left out, no table over P, captains
  // anchored. A failure here is a bug, never something to save.
  const audit = auditSchedule(everyone, { ...planned, rounds: planned.rounds.filter((r) => r.roundNumber >= fromRound) });
  if (!audit.ok) {
    throw new WalkInPlanError("The new seating failed its safety check, so nothing was changed.", { violations: audit.violations.slice(0, 5) });
  }

  // Who now sits somewhere else in the first re-planned round.
  const tableIn = (s: Schedule, pid: number) =>
    s.rounds
      .find((r) => r.roundNumber === fromRound)
      ?.tables.find((t) => t.captainId === pid || t.memberIds.includes(pid))?.tableNumber;
  const moved = new Map<string, number>();
  for (const p of everyone) {
    const after = tableIn(planned, p.id);
    if (after !== undefined && after !== tableIn(schedule, p.id)) moved.set(p._originalUid, after);
  }

  return { schedule: planned, participants: everyone, tablesAdded, moved };
}
