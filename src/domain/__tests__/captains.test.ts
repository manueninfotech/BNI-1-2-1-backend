import { describe, it, expect } from "vitest";
import { resolveCaptains, type ServerParticipant } from "../captains.js";
import {
  auditSchedule,
  generateSchedule,
  tableCountFor,
  validate,
  type ConclaveConfig,
} from "../../engine/index.js";

const SEED = 42;

function makeParticipants(categories: string[]): ServerParticipant[] {
  return categories.map((cat, i) => ({
    id: i + 1,
    name: `P${i + 1}`,
    phone: "",
    businessName: `Biz ${i + 1}`,
    businessCategory: cat,
    location: { withinGuntur: true },
    _originalUid: `uid-${i + 1}`,
  }));
}

/** A roster of `n` people cycling through `k` distinct categories. */
function roster(n: number, k: number): ServerParticipant[] {
  return makeParticipants(Array.from({ length: n }, (_, i) => `cat-${i % k}`));
}

const categoriesOf = (ps: ServerParticipant[], ids: number[]) =>
  ids.map((id) => ps.find((p) => p.id === id)!.businessCategory);

describe("resolveCaptains", () => {
  it("returns exactly T = ceil(A / P) captains when none are designated", () => {
    const ps = roster(30, 10); // A=30, P=7 -> T=5
    expect(resolveCaptains(ps, [], 7, SEED)).toHaveLength(tableCountFor(30, 7));
  });

  it("trims an over-designated captain set down to T", () => {
    const ps = roster(30, 10);
    const T = tableCountFor(30, 7); // 5
    const tooMany = ps.slice(0, 12).map((p) => p.id);

    const captains = resolveCaptains(ps, tooMany, 7, SEED);

    expect(captains).toHaveLength(T);
    // every kept captain came from the designated pool
    expect(captains.every((id) => tooMany.includes(id))).toBe(true);
  });

  it("keeps all designated captains when filling up to T", () => {
    const ps = roster(30, 10);
    const designated = [1, 2];
    const captains = resolveCaptains(ps, designated, 7, SEED);

    expect(captains).toHaveLength(tableCountFor(30, 7));
    for (const id of designated) expect(captains).toContain(id);
  });

  it("spreads captains across distinct categories rather than clustering", () => {
    // Order the roster so the first 5 people ALL share one category: a naive
    // "take the first N" picker would return 5 captains of one category, which
    // is exactly what the old server did.
    const ps = makeParticipants([
      ...Array.from({ length: 5 }, () => "Real Estate"), // ids 1-5, all same
      ...Array.from({ length: 35 }, (_, i) => `cat-${i % 7}`),
    ]);
    const T = tableCountFor(40, 8); // 5

    const captains = resolveCaptains(ps, [], 8, SEED);

    expect(captains).toHaveLength(T);
    expect(new Set(categoriesOf(ps, captains)).size).toBe(T);
  });

  it("ignores designated ids that are not real participants", () => {
    const ps = roster(30, 10);
    const captains = resolveCaptains(ps, [999, 1000], 7, SEED);
    expect(captains).toHaveLength(tableCountFor(30, 7));
    expect(captains).not.toContain(999);
  });

  it("is deterministic for the same roster and seed", () => {
    const ps = roster(120, 15);
    expect(resolveCaptains(ps, [3, 9], 7, SEED)).toEqual(
      resolveCaptains(ps, [3, 9], 7, SEED),
    );
  });

  // The real contract: whatever captains we hand the engine must actually
  // produce a schedule that holds every hard constraint.
  it.each([
    ["300 people, 7/table", 300, 30, 7],
    ["250 people, 7/table", 250, 30, 7],
    ["199 people, 8/table", 199, 25, 8],
    ["118 people, 6/table", 118, 20, 6],
  ])("%s: passes validation and audits clean", (_label, A, k, P) => {
    const ps = roster(A as number, k as number);
    const captains = resolveCaptains(ps, [], P as number, SEED);
    const config: ConclaveConfig = {
      personsPerTable: P as number,
      roundCount: 6,
      seed: SEED,
    };

    const result = validate(ps, captains, config);
    expect(result.errors).toEqual([]);

    const report = auditSchedule(ps, generateSchedule(ps, captains, config));

    expect(report.categoryCollisions).toBe(0); // C1
    expect(report.seatingErrors).toBe(0); // C3
    expect(report.oversizedTables).toBe(0); // C4
    expect(report.captainDrift).toBe(0); // C5
    expect(report.ok).toBe(true);
  });

  // KNOWN ENGINE LIMITATION — pinned so a future engine change surfaces it.
  //
  // When A is an exact multiple of P there are zero spare seats (T*P - A === 0),
  // making each round an exact-cover problem. The matcher is a greedy heuristic
  // with a single-step repair, so it can fail even though the validation gate
  // (V1-V11) passes. This is NOT caused by captain selection: it reproduces with
  // the engine's own autoSelectCaptains too. The server converts this into an
  // actionable 400 rather than a 500.
  it.each([
    ["200 people, 8/table", 200, 25, 8], // 25 tables * 8 = 200 -> slack 0
    ["120 people, 6/table", 120, 20, 6], // 20 tables * 6 = 120 -> slack 0
  ])(
    "%s: zero spare seats defeats the greedy matcher despite passing validation",
    (_label, A, k, P) => {
      const ps = roster(A as number, k as number);
      const captains = resolveCaptains(ps, [], P as number, SEED);
      const config: ConclaveConfig = {
        personsPerTable: P as number,
        roundCount: 6,
        seed: SEED,
      };

      // The gate says yes...
      expect(validate(ps, captains, config).ok).toBe(true);
      // ...but the matcher cannot actually seat it.
      expect(() => generateSchedule(ps, captains, config)).toThrowError(
        /no category-safe table/,
      );
    },
  );
});
