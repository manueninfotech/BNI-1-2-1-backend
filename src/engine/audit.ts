// Independent verifier: given participants + a produced schedule, re-check every
// hard constraint from scratch. Used by tests (accuracy) and by the UI (a live
// "constraints held" badge). Intentionally simple and decoupled from the matcher.

import { occupantsOf, type Participant, type Schedule } from "./types.js";

export interface AuditReport {
  ok: boolean;
  violations: string[];
  // C1: no table has two of the same category (incl. captain)
  categoryCollisions: number;
  // C3: each participant seated exactly once per round
  seatingErrors: number;
  // C4: no table exceeds P
  oversizedTables: number;
  // C5: captains anchored to the same table every round
  captainDrift: number;
  // C2 (soft, reported not failed): pairs that shared a table >1 time
  repeatPairings: number;
}

export function auditSchedule(participants: Participant[], schedule: Schedule): AuditReport {
  const violations: string[] = [];
  const byId = new Map(participants.map((p) => [p.id, p]));
  const P = schedule.config.personsPerTable;

  let categoryCollisions = 0;
  let seatingErrors = 0;
  let oversizedTables = 0;
  let captainDrift = 0;

  // C5: captain -> table number must be constant across rounds.
  const captainTable = new Map<number, number>();

  // C2: pair meeting counts.
  const pairCount = new Map<string, number>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for (const round of schedule.rounds) {
    const seenThisRound = new Set<number>();

    for (const table of round.tables) {
      const occ = occupantsOf(table);

      // C4
      if (occ.length > P) {
        oversizedTables++;
        violations.push(`Round ${round.roundNumber} table ${table.tableNumber} has ${occ.length} > ${P}.`);
      }

      // C5
      const prev = captainTable.get(table.captainId);
      if (prev === undefined) captainTable.set(table.captainId, table.tableNumber);
      else if (prev !== table.tableNumber) {
        captainDrift++;
        violations.push(`Captain ${table.captainId} moved from table ${prev} to ${table.tableNumber}.`);
      }

      // C1 + C3
      const cats = new Set<string>();
      for (const id of occ) {
        if (seenThisRound.has(id)) {
          seatingErrors++;
          violations.push(`Participant ${id} seated twice in round ${round.roundNumber}.`);
        }
        seenThisRound.add(id);

        const cat = byId.get(id)?.businessCategory ?? "?";
        if (cats.has(cat)) {
          categoryCollisions++;
          violations.push(
            `Round ${round.roundNumber} table ${table.tableNumber}: duplicate category "${cat}".`,
          );
        }
        cats.add(cat);
      }

      // C2 accounting
      for (let a = 0; a < occ.length; a++) {
        for (let b = a + 1; b < occ.length; b++) {
          const k = pairKey(occ[a], occ[b]);
          pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
        }
      }
    }

    // C3: everyone seated each round
    if (seenThisRound.size !== participants.length) {
      seatingErrors++;
      violations.push(
        `Round ${round.roundNumber} seated ${seenThisRound.size}/${participants.length} participants.`,
      );
    }
  }

  let repeatPairings = 0;
  for (const c of pairCount.values()) if (c > 1) repeatPairings += c - 1;

  return {
    ok: categoryCollisions === 0 && seatingErrors === 0 && oversizedTables === 0 && captainDrift === 0,
    violations,
    categoryCollisions,
    seatingErrors,
    oversizedTables,
    captainDrift,
    repeatPairings,
  };
}
