import { describe, it, expect } from "vitest";
import { validate, autoSelectCaptains, type ConclaveConfig, type Participant } from "../index.js";
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

const baseCfg = (over: Partial<ConclaveConfig> = {}): ConclaveConfig => ({
  personsPerTable: 7,
  roundCount: 6,
  seed: 1,
  ...over,
});

function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code);
}

describe("validation gate", () => {
  it("passes a healthy 300-person conclave", () => {
    const people = generateSeedParticipants(300);
    const config = baseCfg({ personsPerTable: 7, roundCount: 6 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const result = validate(people, captains, config);
    expect(result.ok).toBe(true);
    expect(result.derived.tableCount).toBe(captains.length);
  });

  it("V10: too few distinct categories for the table size", () => {
    // 20 people but only 3 categories, table size 7 => impossible to diversify.
    const people = Array.from({ length: 20 }, (_, i) => mk(i + 1, ["A", "B", "C"][i % 3]));
    const config = baseCfg({ personsPerTable: 7 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const result = validate(people, captains, config);
    expect(codes(result.errors)).toContain("V10");
    expect(result.ok).toBe(false);
  });

  it("V11: a category has more people than there are tables", () => {
    // 14 people, P=7 => T=2 tables. 5 of them share a category > 2 tables.
    const people: Participant[] = [];
    for (let i = 0; i < 5; i++) people.push(mk(i + 1, "Real Estate"));
    const others = [
      "CA", "Software", "Interior", "Architect", "Caterer", "Restaurant", "Jeweller",
      "Travel", "Insurance",
    ];
    others.forEach((c, i) => people.push(mk(100 + i, c)));
    const config = baseCfg({ personsPerTable: 7 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const result = validate(people, captains, config);
    expect(codes(result.errors)).toContain("V11");
  });

  it("V8: wrong number of captains is rejected", () => {
    const people = generateSeedParticipants(60);
    const config = baseCfg({ personsPerTable: 7, roundCount: 5 }); // T = ceil(60/7) = 9
    const tooFew = autoSelectCaptains(people, config.personsPerTable, config.seed).slice(0, 5);
    const result = validate(people, tooFew, config);
    expect(codes(result.errors)).toContain("V8");
  });

  it("V7: not enough people to fill a table", () => {
    const people = Array.from({ length: 4 }, (_, i) => mk(i + 1, `Cat${i}`));
    const config = baseCfg({ personsPerTable: 7 });
    const result = validate(people, [1], config);
    expect(codes(result.errors)).toContain("V7");
  });

  it("V5: round count outside the 4..8 window", () => {
    const people = generateSeedParticipants(60);
    const config = baseCfg({ personsPerTable: 7, roundCount: 2 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const result = validate(people, captains, config);
    expect(codes(result.errors)).toContain("V5");
  });

  it("W2: warns on uneven tables but still passes", () => {
    const people = generateSeedParticipants(300); // 300 / 7 is uneven
    const config = baseCfg({ personsPerTable: 7, roundCount: 6 });
    const captains = autoSelectCaptains(people, config.personsPerTable, config.seed);
    const result = validate(people, captains, config);
    expect(codes(result.warnings)).toContain("W2");
    expect(result.ok).toBe(true);
  });
});
