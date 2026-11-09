// Benchmark the seating engine on realistic rosters: quality (repeats, people
// met), balance (table sizes), hard constraints (audit) and speed.
// Run: npx tsx scripts/matcher-bench.ts
import { generateSchedule, autoSelectCaptains, auditSchedule } from "../src/engine/index.js";
import { generateSeedParticipants } from "../src/data/seed.js";

const cases: [number, number, number][] = [
  [26, 5, 5], [30, 5, 5], [31, 5, 5], [23, 5, 4], [61, 8, 6], [64, 8, 6],
  [150, 8, 8], [213, 6, 5], [300, 7, 7], [330, 8, 8], [1000, 8, 8], [5000, 8, 8],
];
for (const [A, P, R] of cases) {
  const people = generateSeedParticipants(A, 1000 + A);
  const seed = 4242;
  try {
    const caps = autoSelectCaptains(people, P, seed);
    const t0 = performance.now();
    const s = generateSchedule(people, caps, { personsPerTable: P, roundCount: R, seed });
    const ms = performance.now() - t0;
    const a = auditSchedule(people, s);
    let spread = 0, smallest = 99;
    for (const r of s.rounds) {
      const sz = r.tables.map((t) => 1 + t.memberIds.length);
      spread = Math.max(spread, Math.max(...sz) - Math.min(...sz));
      smallest = Math.min(smallest, ...sz);
    }
    console.log(
      `${String(A).padStart(5)} @${P} x${R}: ok=${a.ok} repeats=${s.stats.repeatPairings} ` +
      `minMet=${s.stats.minUniqueMetPerMember} avgMet=${s.stats.avgUniqueMetPerMember.toFixed(2)} ` +
      `sizeSpread=${spread} smallest=${smallest} ${ms.toFixed(0)}ms`);
  } catch (e) {
    console.log(`${String(A).padStart(5)} @${P} x${R}: FAILED ${(e as Error).message.slice(0, 90)}`);
  }
}
