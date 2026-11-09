// Stress the seating engine with hard, skewed rosters: many people sharing a
// category (up to the table count), every size and table setting. Every result
// is re-checked by the independent auditor and for balance.
// Run: npx tsx scripts/matcher-stress.ts
import { generateSchedule, autoSelectCaptains, auditSchedule, validate, type Participant } from "../src/engine/index.js";
import { makeRng } from "../src/engine/rng.js";

let runs = 0, fails = 0, uneven = 0, invalid = 0;
const rng = makeRng(99);
for (let trial = 0; trial < 3000; trial++) {
  const P = 3 + Math.floor(rng() * 6); // 3..8
  const A = P + 1 + Math.floor(rng() * (trial % 10 === 0 ? 600 : 120));
  const T = Math.ceil(A / P);
  // Skewed categories: a few heavy ones (up to T people), the rest light.
  const people: Participant[] = [];
  let id = 1, cat = 0;
  while (people.length < A) {
    const heavy = rng() < 0.25;
    const n = Math.min(A - people.length, heavy ? 1 + Math.floor(rng() * T) : 1 + Math.floor(rng() * 2));
    for (let i = 0; i < n; i++) people.push({ id: id++, name: "", phone: "", businessName: "", businessCategory: "c" + cat, location: { withinGuntur: true } });
    cat++;
  }
  const R = 2 + Math.floor(rng() * 7);
  const seed = Math.floor(rng() * 1e9);
  const caps = autoSelectCaptains(people, P, seed);
  const config = { personsPerTable: P, roundCount: R, seed };
  if (!validate(people, caps, config).ok) { invalid++; continue; }
  runs++;
  try {
    const s = generateSchedule(people, caps, config);
    const a = auditSchedule(people, s);
    if (!a.ok) { fails++; console.log("AUDIT FAIL", A, P, a.violations.slice(0, 2)); continue; }
    for (const r of s.rounds) {
      const sz = r.tables.map((t) => 1 + t.memberIds.length);
      if (Math.max(...sz) - Math.min(...sz) > 1) { uneven++; break; }
    }
  } catch (e) {
    fails++;
    if (fails < 8) console.log("THROW", A, P, R, (e as Error).message.slice(0, 80));
  }
}
console.log({ runs, fails, uneven, skippedInvalidRosters: invalid });
