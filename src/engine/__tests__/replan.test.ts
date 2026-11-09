import { describe, it, expect } from "vitest";
import {
  auditSchedule,
  autoSelectCaptains,
  generateSchedule,
  planSchedule,
  type Participant,
  type Schedule,
} from "../index.js";
import { generateSeedParticipants } from "../../data/seed.js";

const sizes = (s: Schedule, round: number) =>
  s.rounds
    .find((r) => r.roundNumber === round)!
    .tables.map((t) => (t.captainId === null ? 0 : 1) + t.memberIds.length)
    .sort((a, b) => b - a);

/** Category clashes and double seating, checked independently of the engine. */
function hardOk(people: Participant[], s: Schedule) {
  const cat = new Map(people.map((p) => [p.id, p.businessCategory]));
  for (const r of s.rounds) {
    const seen = new Set<number>();
    for (const t of r.tables) {
      const occ = [t.captainId, ...t.memberIds].filter((x): x is number => x !== null);
      const cats = occ.map((id) => cat.get(id));
      expect(new Set(cats).size).toBe(cats.length);
      for (const id of occ) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(people.length);
  }
}

describe("balanced tables (organisers' rule)", () => {
  it("26 people at 5 per table -> 6 tables of 5,5,4,4,4,4 every round", () => {
    const people = generateSeedParticipants(26, 7);
    const caps = autoSelectCaptains(people, 5, 1);
    const s = generateSchedule(people, caps, { personsPerTable: 5, roundCount: 5, seed: 1 });
    expect(s.tableCount).toBe(6);
    for (let r = 1; r <= 5; r++) expect(sizes(s, r)).toEqual([5, 5, 4, 4, 4, 4]);
  });

  it("31 people at 5 per table -> 7 tables of 5,5,5,4,4,4,4 every round", () => {
    const people = generateSeedParticipants(31, 8);
    const caps = autoSelectCaptains(people, 5, 2);
    const s = generateSchedule(people, caps, { personsPerTable: 5, roundCount: 5, seed: 2 });
    expect(s.tableCount).toBe(7);
    for (let r = 1; r <= 5; r++) expect(sizes(s, r)).toEqual([5, 5, 5, 4, 4, 4, 4]);
  });

  it("never seats more than 8 or fewer than floor(A/T)", () => {
    for (const A of [9, 17, 63, 65, 161, 333]) {
      const people = generateSeedParticipants(A, A);
      const caps = autoSelectCaptains(people, 8, A);
      const s = generateSchedule(people, caps, { personsPerTable: 8, roundCount: 6, seed: A });
      const floor = Math.floor(A / s.tableCount);
      for (const r of s.rounds) {
        for (const t of r.tables) {
          const n = 1 + t.memberIds.length;
          expect(n).toBeLessThanOrEqual(8);
          expect(n).toBeGreaterThanOrEqual(floor);
        }
      }
      expect(auditSchedule(people, s).ok).toBe(true);
    }
  });
});

describe("re-planning mid-event (walk-ins)", () => {
  const P = 5;
  const R = 6;
  const people = generateSeedParticipants(30, 30); // exactly full: 6 tables of 5
  const caps = autoSelectCaptains(people, P, 3);
  const original = generateSchedule(people, caps, { personsPerTable: P, roundCount: R, seed: 3 });
  const played = original.rounds.filter((r) => r.roundNumber < 3);

  const walkIns: Participant[] = generateSeedParticipants(60, 999)
    .slice(30, 33)
    .map((p, i) => ({ ...p, id: 31 + i, businessCategory: `Walk-in category ${i}` }));
  const everyone = [...people, ...walkIns];

  it("keeps played rounds exactly as they were", () => {
    const tables = original.rounds[0].tables.map((t) => ({ tableNumber: t.tableNumber, captainId: t.captainId }));
    tables.push({ tableNumber: 7, captainId: 31 }); // the full room needs one more table
    const s = planSchedule({
      participants: everyone,
      tables,
      config: { personsPerTable: P, roundCount: R, seed: 3 },
      history: played,
      fromRound: 3,
    });
    expect(JSON.stringify(s.rounds.slice(0, 2))).toBe(JSON.stringify(played));
    expect(s.rounds).toHaveLength(R);
  });

  it("seats walk-ins from the next round, balanced, category-safe, captains anchored", () => {
    const tables = original.rounds[0].tables.map((t) => ({ tableNumber: t.tableNumber, captainId: t.captainId }));
    tables.push({ tableNumber: 7, captainId: 31 });
    const s = planSchedule({
      participants: everyone,
      tables,
      config: { personsPerTable: P, roundCount: R, seed: 3 },
      history: played,
      fromRound: 3,
    });
    // 33 people at 7 tables -> 5,5,5,5,5,4,4 from round 3 on.
    for (let r = 3; r <= R; r++) expect(sizes(s, r)).toEqual([5, 5, 5, 5, 5, 4, 4]);
    // Played rounds don't include the walk-ins; audit the planned ones only.
    const planned = { ...s, rounds: s.rounds.filter((r) => r.roundNumber >= 3) };
    hardOk(everyone, planned);
    const report = auditSchedule(everyone, planned);
    expect(report.categoryCollisions + report.oversizedTables + report.captainDrift + report.seatingErrors).toBe(0);
  });

  it("uses the played rounds: nobody re-meets a round-1/2 tablemate when it can be avoided", () => {
    const tables = original.rounds[0].tables.map((t) => ({ tableNumber: t.tableNumber, captainId: t.captainId }));
    tables.push({ tableNumber: 7, captainId: 31 });
    const replanned = planSchedule({
      participants: everyone,
      tables,
      config: { personsPerTable: P, roundCount: 3, seed: 3 },
      history: played,
      fromRound: 3,
    });
    // Captains are fixed, so captain-captain pairs never repeat; count member repeats.
    const pairs = new Map<string, number>();
    for (const r of replanned.rounds) {
      for (const t of r.tables) {
        const occ = [t.captainId!, ...t.memberIds];
        for (let a = 0; a < occ.length; a++)
          for (let b = a + 1; b < occ.length; b++) {
            const k = occ[a] < occ[b] ? `${occ[a]}:${occ[b]}` : `${occ[b]}:${occ[a]}`;
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
          }
      }
    }
    const repeats = [...pairs.values()].filter((c) => c > 1).length;
    expect(repeats).toBe(0);
  });

  it("is deterministic", () => {
    const tables = original.rounds[0].tables.map((t) => ({ tableNumber: t.tableNumber, captainId: t.captainId }));
    const input = {
      participants: [...people, walkIns[0]],
      tables,
      config: { personsPerTable: P + 1, roundCount: R, seed: 3 },
      history: played,
      fromRound: 3,
    };
    expect(JSON.stringify(planSchedule(input).rounds)).toBe(JSON.stringify(planSchedule(input).rounds));
  });
});

describe("tables without a captain", () => {
  it("seats everyone evenly with no anchors", () => {
    const people = generateSeedParticipants(40, 4);
    const tables = Array.from({ length: 8 }, (_, i) => ({ tableNumber: i + 1, captainId: null }));
    const s = planSchedule({ participants: people, tables, config: { personsPerTable: 5, roundCount: 5, seed: 4 } });
    for (let r = 1; r <= 5; r++) expect(sizes(s, r)).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    hardOk(people, s);
  });
});

describe("scale", () => {
  it("5,000 people x 8 rounds at 8 per table: valid, balanced and fast", () => {
    const people = generateSeedParticipants(5000, 5);
    const caps = autoSelectCaptains(people, 8, 5);
    const t0 = performance.now();
    const s = generateSchedule(people, caps, { personsPerTable: 8, roundCount: 8, seed: 5 });
    const ms = performance.now() - t0;
    expect(auditSchedule(people, s).ok).toBe(true);
    for (let r = 1; r <= 8; r++) expect(new Set(sizes(s, r))).toEqual(new Set([8]));
    expect(ms).toBeLessThan(5000);
  });
});
