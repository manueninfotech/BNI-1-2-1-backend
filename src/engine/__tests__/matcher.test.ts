import { describe, it, expect } from "vitest";
import {
  generateSchedule,
  auditSchedule,
  autoSelectCaptains,
  type ConclaveConfig,
  type Participant,
} from "../index.js";
import { generateSeedParticipants } from "../../data/seed.js";

function mk(id: number, category: string): Participant {
  return {
    id,
    name: `P${id}`,
    phone: "+91 9000000000",
    businessName: `Biz ${id}`,
    businessCategory: category,
    location: { withinGuntur: true },
  };
}

const cfg = (over: Partial<ConclaveConfig> = {}): ConclaveConfig => ({
  personsPerTable: 7,
  roundCount: 6,
  seed: 42,
  ...over,
});

describe("matching engine — hard constraints", () => {
  it("the original 6-person example: the two Software Devs never share a table", () => {
    // Ganesh(1) & Samba(3) are both Software Dev and must never share a table (C1).
    const people = [
      mk(1, "Software Dev"), // Ganesh
      mk(2, "Boutique"), // Sravan
      mk(3, "Software Dev"), // Samba
      mk(4, "Restaurant"), // Kartheek
      mk(5, "Caterer"), // Bhanu
      mk(6, "Real Estate"), // Prakash
    ];
    const config = cfg({ personsPerTable: 2, roundCount: 3, seed: 7 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    expect(captains).toHaveLength(3); // T = ceil(6/2)

    const schedule = generateSchedule(people, captains, config);
    const report = auditSchedule(people, schedule);

    expect(report.ok).toBe(true);
    expect(report.categoryCollisions).toBe(0);

    // Explicit: 1 and 3 are never co-located in any round.
    for (const round of schedule.rounds) {
      for (const t of round.tables) {
        const occ = [t.captainId, ...t.memberIds];
        expect(occ.includes(1) && occ.includes(3)).toBe(false);
      }
    }
  });

  it("achieves ZERO repeats when rounds fit comfortably within capacity", () => {
    // 300 people, 43 tables, only 2 rounds => the optimizer has ample room to
    // give everyone an entirely fresh table in round 2.
    const people = generateSeedParticipants(300);
    const config = cfg({ personsPerTable: 7, roundCount: 2, seed: 13 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const schedule = generateSchedule(people, captains, config);

    expect(auditSchedule(people, schedule).ok).toBe(true);
    expect(schedule.stats.repeatPairings).toBe(0);
  });

  it("never seats two of the same category together (300 participants)", () => {
    const people = generateSeedParticipants(300);
    const config = cfg({ personsPerTable: 7, roundCount: 6, seed: 2026 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);

    const schedule = generateSchedule(people, captains, config);
    const report = auditSchedule(people, schedule);

    expect(report.categoryCollisions).toBe(0);
    expect(report.seatingErrors).toBe(0);
    expect(report.oversizedTables).toBe(0);
    expect(report.captainDrift).toBe(0);
    expect(report.ok).toBe(true);
  });

  it("seats every participant exactly once per round and keeps captains anchored", () => {
    const people = generateSeedParticipants(213);
    const config = cfg({ personsPerTable: 6, roundCount: 5, seed: 99 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const schedule = generateSchedule(people, captains, config);

    expect(schedule.tableCount).toBe(captains.length);
    for (const round of schedule.rounds) {
      const seen = new Set<number>();
      for (const t of round.tables) {
        seen.add(t.captainId);
        for (const m of t.memberIds) seen.add(m);
        expect(t.memberIds.length + 1).toBeLessThanOrEqual(config.personsPerTable);
      }
      expect(seen.size).toBe(people.length);
    }
  });
});

describe("matching engine — objective (maximize unique meetings)", () => {
  it("achieves high coverage and a healthy minimum per person", () => {
    const people = generateSeedParticipants(300);
    const config = cfg({ personsPerTable: 7, roundCount: 7, seed: 5 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const schedule = generateSchedule(people, captains, config);
    const { stats } = schedule;

    // Each round a person meets up to P-1 = 6 others. Over 7 rounds, with low
    // repeats, everyone should meet a large, mostly-distinct set.
    expect(stats.minUniqueMetPerMember).toBeGreaterThanOrEqual(config.personsPerTable);
    expect(stats.avgUniqueMetPerMember).toBeGreaterThan(config.roundCount * (config.personsPerTable - 1) * 0.7);
    // Repeat rate should be a small fraction of total meetings.
    const totalMeetings = stats.uniquePairsMet + stats.repeatPairings;
    expect(stats.repeatPairings / totalMeetings).toBeLessThan(0.15);
  });

  it("auditor's repeat count matches the engine's reported stat", () => {
    const people = generateSeedParticipants(150);
    const config = cfg({ personsPerTable: 7, roundCount: 6, seed: 11 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const schedule = generateSchedule(people, captains, config);
    const report = auditSchedule(people, schedule);
    expect(report.repeatPairings).toBe(schedule.stats.repeatPairings);
  });
});

describe("matching engine — determinism", () => {
  it("same seed + same inputs => identical schedule", () => {
    const people = generateSeedParticipants(120);
    const config = cfg({ personsPerTable: 7, roundCount: 6, seed: 314 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);

    const a = generateSchedule(people, captains, config);
    const b = generateSchedule(people, captains, config);
    expect(JSON.stringify(a.rounds)).toBe(JSON.stringify(b.rounds));
    expect(a.stats).toEqual(b.stats);
  });

  it("does not mutate the input participants array", () => {
    const people = generateSeedParticipants(60);
    const snapshot = JSON.stringify(people);
    const config = cfg({ personsPerTable: 6, roundCount: 5, seed: 1 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    generateSchedule(people, captains, config);
    expect(JSON.stringify(people)).toBe(snapshot);
  });
});

describe("matching engine — performance", () => {
  it("schedules 300 people x 8 rounds quickly", () => {
    const people = generateSeedParticipants(300);
    const config = cfg({ personsPerTable: 7, roundCount: 8, seed: 77 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);

    const start = performance.now();
    const schedule = generateSchedule(people, captains, config);
    const ms = performance.now() - start;

    expect(auditSchedule(people, schedule).ok).toBe(true);
    expect(ms).toBeLessThan(500); // generous CI headroom; typically a few ms
  });
});
