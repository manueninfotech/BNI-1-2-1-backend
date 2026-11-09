import { describe, it, expect } from "vitest";
import { autoSelectCaptains, generateSchedule, auditSchedule, planSchedule } from "../../engine/index.js";
import { generateSeedParticipants } from "../../data/seed.js";
import type { ServerParticipant } from "../captains.js";
import type { ClockRow } from "../roundClock.js";
import { joinsFromRound, planWithWalkIns, WalkInPlanError } from "../walkIns.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 5, 0, 0);

function roster(n: number, seed: number): ServerParticipant[] {
  return generateSeedParticipants(n, seed).map((p) => ({ ...p, _originalUid: `u${p.id}` }));
}
function walkIns(from: number, n: number): ServerParticipant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i,
    name: `Walk-in ${i}`,
    phone: "",
    businessName: "",
    businessCategory: `Walk-in category ${i}`,
    location: { withinGuntur: true },
    _originalUid: `w${i}`,
  }));
}
function setup(n: number, P: number, R: number) {
  const people = roster(n, n);
  const caps = autoSelectCaptains(people, P, 9);
  const schedule = generateSchedule(people, caps, { personsPerTable: P, roundCount: R, seed: 9 });
  return { people, schedule };
}
const sizes = (s: { rounds: { roundNumber: number; tables: { captainId: number | null; memberIds: number[] }[] }[] }, r: number) =>
  s.rounds.find((x) => x.roundNumber === r)!.tables.map((t) => (t.captainId === null ? 0 : 1) + t.memberIds.length).sort((a, b) => b - a);

describe("joinsFromRound", () => {
  const row = (over: Partial<ClockRow> = {}): ClockRow => ({
    currentRound: 2,
    currentRoundStartedAt: new Date(T0),
    roundCount: 5,
    personsPerTable: 8, // 12 min of talking
    roundProgressionMode: "manual",
    moveSeconds: 120,
    ...over,
  });

  it("while tables are talking, joins the next round", () => {
    expect(joinsFromRound(row(), T0 + 3 * MIN)).toBe(3);
  });
  it("once the round is over (people moving / waiting), skips the round they are walking to", () => {
    expect(joinsFromRound(row(), T0 + 13 * MIN)).toBe(4);
  });
  it("during or after the last round there is nothing to join", () => {
    expect(joinsFromRound(row({ currentRound: 5 }), T0 + 3 * MIN)).toBeNull();
  });
});

describe("planWithWalkIns", () => {
  it("fills a free seat without opening a table (26 -> 27 at 5 per table)", () => {
    const { people, schedule } = setup(26, 5, 5);
    const plan = planWithWalkIns({
      schedule, participants: people, newcomers: walkIns(27, 1),
      personsPerTable: 5, roundCount: 5, seed: 9, captainless: false, fromRound: 3,
    });
    expect(plan.tablesAdded).toEqual([]);
    for (const r of [3, 4, 5]) expect(sizes(plan.schedule, r)).toEqual([5, 5, 5, 4, 4, 4]);
    expect(JSON.stringify(plan.schedule.rounds.slice(0, 2))).toBe(JSON.stringify(schedule.rounds.slice(0, 2)));
  });

  it("when every table is full, asks for the new table's captain", () => {
    const { people, schedule } = setup(30, 5, 5);
    expect(() =>
      planWithWalkIns({
        schedule, participants: people, newcomers: walkIns(31, 1),
        personsPerTable: 5, roundCount: 5, seed: 9, captainless: false, fromRound: 2,
      }),
    ).toThrowError(WalkInPlanError);
  });

  it("opens a table with the chosen captain and re-balances (30 -> 31 = 3x5 + 4x4)", () => {
    const { people, schedule } = setup(30, 5, 5);
    const newcomer = walkIns(31, 1);
    const plan = planWithWalkIns({
      schedule, participants: people, newcomers: newcomer,
      personsPerTable: 5, roundCount: 5, seed: 9, captainless: false, fromRound: 2,
      newTableCaptainIds: [31],
    });
    expect(plan.tablesAdded).toEqual([7]);
    for (const r of [2, 3, 4, 5]) expect(sizes(plan.schedule, r)).toEqual([5, 5, 5, 4, 4, 4, 4]);
    const t7 = plan.schedule.rounds[1].tables.find((t) => t.tableNumber === 7)!;
    expect(t7.captainId).toBe(31);
    const everyone = [...people, ...newcomer];
    const planned = { ...plan.schedule, rounds: plan.schedule.rounds.filter((r) => r.roundNumber >= 2) };
    expect(auditSchedule(everyone, planned).ok).toBe(true);
    expect(plan.moved.size).toBeGreaterThan(0);
  });

  it("captainless conclaves open new tables without a captain", () => {
    const people = roster(20, 20);
    const base = planSchedule({
      participants: people,
      tables: [1, 2, 3, 4].map((n) => ({ tableNumber: n, captainId: null })),
      config: { personsPerTable: 5, roundCount: 4, seed: 3 },
    });
    const plan = planWithWalkIns({
      schedule: base, participants: people, newcomers: walkIns(21, 3),
      personsPerTable: 5, roundCount: 4, seed: 3, captainless: true, fromRound: 2,
    });
    expect(plan.tablesAdded).toEqual([5]);
    for (const r of [2, 3, 4]) expect(sizes(plan.schedule, r)).toEqual([5, 5, 5, 4, 4]);
  });

  it("refuses when no rounds are left", () => {
    const { people, schedule } = setup(26, 5, 3);
    expect(() =>
      planWithWalkIns({
        schedule, participants: people, newcomers: walkIns(27, 1),
        personsPerTable: 5, roundCount: 3, seed: 9, captainless: false, fromRound: 4,
      }),
    ).toThrowError(/no rounds left/);
  });

  it("never seats a walk-in with someone of the same business category", () => {
    const { people, schedule } = setup(35, 8, 6); // 5 tables, 5 free seats
    // Walk-ins that share categories with people already seated.
    const clones = people.slice(0, 5).map((p, i) => ({ ...p, id: 36 + i, _originalUid: `c${i}`, name: `Clone ${i}` }));
    const plan = planWithWalkIns({
      schedule, participants: people, newcomers: clones,
      personsPerTable: 8, roundCount: 6, seed: 9, captainless: false, fromRound: 3,
    });
    const everyone = [...people, ...clones];
    const planned = { ...plan.schedule, rounds: plan.schedule.rounds.filter((r) => r.roundNumber >= 3) };
    expect(auditSchedule(everyone, planned).categoryCollisions).toBe(0);
  });
});
