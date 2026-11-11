import { describe, it, expect } from "vitest";
import {
  auditSchedule,
  chapterKey,
  planSchedule,
  resolveSeatingRules,
  validate,
  DEFAULT_SEATING_RULES,
  type ConclaveConfig,
  type Participant,
  type Schedule,
  type SeatingRules,
} from "../index.js";
import { planWithWalkIns } from "../../domain/walkIns.js";

// Per-conclave seating rules (SeatingRules): category on/off, chapter on/off,
// balanced tables on/off. The defaults must reproduce the old behaviour.

function person(id: number, category: string, chapter?: string): Participant {
  return {
    id,
    name: `P${id}`,
    phone: "",
    businessName: `Biz ${id}`,
    businessCategory: category,
    location: { withinGuntur: true },
    chapter,
  };
}

/** n people, every category different, chapters assigned by `chapterOf`. */
function roster(n: number, chapterOf: (i: number) => string | undefined): Participant[] {
  return Array.from({ length: n }, (_, i) => person(i + 1, `Cat ${i + 1}`, chapterOf(i)));
}

function plan(people: Participant[], P: number, rounds: number, rules?: Partial<SeatingRules>): Schedule {
  const T = Math.ceil(people.length / P);
  const config: ConclaveConfig = {
    personsPerTable: P,
    roundCount: rounds,
    seed: 11,
    tableCount: T,
    captainless: true,
    rules: rules ? { ...DEFAULT_SEATING_RULES, ...rules } : undefined,
  };
  return planSchedule({
    participants: people,
    tables: Array.from({ length: T }, (_, i) => ({ tableNumber: i + 1, captainId: null })),
    config,
  });
}

/** Largest number of one chapter's members at any single table, any round. */
function maxPerTable(people: Participant[], schedule: Schedule, chapter: string): number {
  const ch = new Map(people.map((p) => [p.id, chapterKey(p.chapter)]));
  let max = 0;
  for (const r of schedule.rounds) {
    for (const t of r.tables) {
      const n = t.memberIds.filter((id) => ch.get(id) === chapterKey(chapter)).length;
      max = Math.max(max, n);
    }
  }
  return max;
}

describe("seating rules: defaults", () => {
  it("default rules are category on, chapter off, balanced on", () => {
    expect(resolveSeatingRules(undefined)).toEqual({ category: "separate", chapter: "off", balancedTables: true });
    expect(resolveSeatingRules({ chapter: "nonsense", balancedTables: "yes" })).toEqual(DEFAULT_SEATING_RULES);
  });

  it("with no rules set, chapter members may share a table (old behaviour)", () => {
    // 18 people, 3 tables of 6, one chapter of 9: nothing keeps them apart.
    const people = roster(18, (i) => (i < 9 ? "Atoms" : undefined));
    const s = plan(people, 6, 3);
    expect(maxPerTable(people, s, "Atoms")).toBeGreaterThan(1);
  });
});

describe("seating rules: chapter separation", () => {
  it("keeps every chapter apart while it has no more people than tables", () => {
    // 36 people, 6 tables of 6; chapters of 6, 6, 5 and some with none.
    const chapters = ["Atoms", "Bytes", "Cells"];
    const people = roster(36, (i) => (i < 17 ? chapters[i % 3] : undefined));
    const s = plan(people, 6, 4, { chapter: "separate" });
    for (const c of chapters) expect(maxPerTable(people, s, c)).toBe(1);
    const report = auditSchedule(people, s);
    expect(report.ok).toBe(true);
    expect(report.chapterOverflows).toBe(0);
    expect(s.stats.chapterRelaxedRounds).toBe(0);
  });

  it("spreads a chapter bigger than the table count evenly", () => {
    // 6 tables, chapter of 13: at most ceil(13 / 6) = 3 at any table.
    const people = roster(36, (i) => (i < 13 ? "Atoms" : undefined));
    const s = plan(people, 6, 4, { chapter: "separate" });
    expect(maxPerTable(people, s, "Atoms")).toBe(3);
    expect(auditSchedule(people, s).chapterOverflows).toBe(0);
  });

  it("treats spelling variants of a chapter as one chapter", () => {
    expect(chapterKey("Amaravati")).toBe("amaravati");
    expect(chapterKey("  AMARAVATI chapter ")).toBe("amaravati");
    expect(chapterKey("Amaravati-Chapter")).toBe("amaravati");
    expect(chapterKey("")).toBe("");
    const spellings = ["Amaravati", "amaravati chapter", " AMARAVATI "];
    const people = roster(24, (i) => (i < 4 ? spellings[i % 3] : undefined));
    const s = plan(people, 6, 3, { chapter: "separate" });
    expect(maxPerTable(people, s, "Amaravati")).toBe(1);
  });

  it("still keeps categories apart alongside chapters", () => {
    // 5 tables. Pairs share a category; six chapters of 5 cut across them.
    const chapters = ["Atoms", "Bytes", "Cells", "Dots", "Echo", "Flux"];
    const people = Array.from({ length: 30 }, (_, i) => person(i + 1, `Cat ${Math.floor(i / 2)}`, chapters[i % 6]));
    const s = plan(people, 6, 3, { chapter: "separate" });
    expect(auditSchedule(people, s).categoryCollisions).toBe(0);
    for (const c of chapters) expect(maxPerTable(people, s, c)).toBe(1);
  });

  it("warns before scheduling when a chapter is bigger than the table count", () => {
    const people = roster(36, (i) => (i < 13 ? "Atoms" : undefined));
    const cfg = (chapter: "separate" | "off"): ConclaveConfig => ({
      personsPerTable: 6, roundCount: 3, seed: 1, captainless: true, rules: { ...DEFAULT_SEATING_RULES, chapter },
    });
    expect(validate(people, [], cfg("separate")).warnings.some((w) => w.code === "W4")).toBe(true);
    expect(validate(people, [], cfg("off")).warnings.some((w) => w.code === "W4")).toBe(false);
  });
});

describe("seating rules: category and balance switches", () => {
  it("category off allows a shared category and skips the category checks", () => {
    const people = Array.from({ length: 24 }, (_, i) => person(i + 1, "Same"));
    const cfg: ConclaveConfig = {
      personsPerTable: 6, roundCount: 3, seed: 1, captainless: true, rules: { ...DEFAULT_SEATING_RULES, category: "off" },
    };
    expect(validate(people, [], cfg).ok).toBe(true);
    expect(validate(people, [], { ...cfg, rules: DEFAULT_SEATING_RULES }).ok).toBe(false);
    const s = plan(people, 6, 3, { category: "off" });
    expect(auditSchedule(people, s).ok).toBe(true);
  });

  it("balanced tables off still never seats more than P", () => {
    const people = roster(26, () => undefined);
    const s = plan(people, 5, 3, { balancedTables: false });
    for (const r of s.rounds) for (const t of r.tables) expect(t.memberIds.length).toBeLessThanOrEqual(5);
    expect(auditSchedule(people, s).ok).toBe(true);
  });
});

describe("seating rules: walk-ins keep the schedule's rules", () => {
  it("a re-plan for a walk-in uses the rules the schedule was made with", () => {
    const people = roster(30, (i) => (i < 5 ? "Atoms" : undefined));
    const schedule = plan(people, 6, 4, { chapter: "separate" });
    const newcomer = { ...person(31, "Cat 31", "Atoms"), _originalUid: "w1" } as never;
    const result = planWithWalkIns({
      schedule,
      participants: people.map((p) => ({ ...p, _originalUid: `u${p.id}` })) as never,
      newcomers: [newcomer],
      personsPerTable: 6,
      roundCount: 4,
      seed: 5,
      captainless: true,
      fromRound: 3,
    });
    expect(result.schedule.config.rules?.chapter).toBe("separate");
    const everyone = [...people, person(31, "Cat 31", "Atoms")];
    const later = { ...result.schedule, rounds: result.schedule.rounds.filter((r) => r.roundNumber >= 3) };
    expect(maxPerTable(everyone, later, "Atoms")).toBe(1);
  });
});
