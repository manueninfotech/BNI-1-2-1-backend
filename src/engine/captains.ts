// Captain selection. In production the admin designates captains; for testing
// the engine we auto-pick T captains that span as many distinct business
// categories as possible. Spreading captain categories eases the C1 hard
// constraint and the V11/V12 feasibility checks.

import { type Participant } from "./types.js";
import { tableCountFor } from "./validation.js";
import { makeRng, shuffle } from "./rng.js";

/**
 * Choose `tableCount` captains, preferring one-per-category coverage.
 * Deterministic for a given seed.
 */
export function autoSelectCaptains(
  participants: Participant[],
  personsPerTable: number,
  seed: number,
): number[] {
  const T = tableCountFor(participants.length, personsPerTable);
  if (T <= 0) return [];

  const rng = makeRng(seed ^ 0x9e3779b9);

  // Bucket participants by category, shuffled for variety.
  const byCategory = new Map<string, Participant[]>();
  for (const p of shuffle(participants, rng)) {
    const arr = byCategory.get(p.businessCategory);
    if (arr) arr.push(p);
    else byCategory.set(p.businessCategory, [p]);
  }

  const buckets = shuffle([...byCategory.values()], rng);
  const chosen: number[] = [];
  const cursor = buckets.map(() => 0);

  // Round-robin across categories: take one new category each pass before
  // taking a second from any category.
  let progressed = true;
  while (chosen.length < T && progressed) {
    progressed = false;
    for (let b = 0; b < buckets.length && chosen.length < T; b++) {
      const idx = cursor[b];
      if (idx < buckets[b].length) {
        chosen.push(buckets[b][idx].id);
        cursor[b] = idx + 1;
        progressed = true;
      }
    }
  }
  return chosen;
}

/**
 * Pick the required number of captains (T = ceil(A / P)) uniformly at random.
 * Deterministic for a given seed; pass a fresh seed (e.g. Date.now()) to get a
 * new random set on each call.
 */
export function randomSelectCaptains(
  participants: Participant[],
  personsPerTable: number,
  seed: number,
): number[] {
  const T = tableCountFor(participants.length, personsPerTable);
  if (T <= 0) return [];
  const rng = makeRng(seed);
  return shuffle(participants, rng)
    .slice(0, T)
    .map((p) => p.id);
}
