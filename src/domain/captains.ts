// Captain resolution for the Firestore-backed admin flow.
//
// Kept out of index.ts so it can be unit-tested without booting Express.

import {
  autoSelectCaptains,
  makeRng,
  shuffle,
  tableCountFor,
  type Participant,
} from "../engine/index.js";

/**
 * A Participant plus the Firestore uid it came from, so engine ids (dense
 * integers, required by the matcher) can be mapped back to real users.
 */
export interface ServerParticipant extends Participant {
  _originalUid: string;
}

/**
 * Resolve the captain set to exactly T = ceil(A / P), honouring the admin's
 * designations where possible.
 *
 * Why this matters: the engine treats captains as fixed table anchors and
 * derives the table count from captainIds.length — so handing it the wrong
 * number silently changes the number of tables. It also enforces C1 (no two
 * people of the same business category at a table) as a hard constraint, which
 * makes captain categories load-bearing: a category-b member can never sit at a
 * category-b captain's table. Captains clustered into few categories therefore
 * choke the matcher (this is what V12 warns about).
 *
 * When nothing is designated we defer entirely to the engine's autoSelectCaptains,
 * which is the tested, seeded, category-spreading picker. The local spread below
 * only exists for the partial cases the engine has no entry point for (some
 * captains designated, but not exactly T).
 *
 * Deterministic for a given seed.
 */
export function resolveCaptains(
  participants: ServerParticipant[],
  designatedIds: number[],
  personsPerTable: number,
  seed: number,
): number[] {
  const T = tableCountFor(participants.length, personsPerTable);
  if (T <= 0) return [];

  const byId = new Map(participants.map((p) => [p.id, p]));
  const designated = [...new Set(designatedIds.filter((id) => byId.has(id)))];

  // Common case: admin designated nobody. Use the engine's own picker.
  if (designated.length === 0) {
    return autoSelectCaptains(participants, personsPerTable, seed);
  }

  if (designated.length === T) return designated;

  const categoryOf = (id: number) => byId.get(id)?.businessCategory ?? "Uncategorized";
  const rng = makeRng(seed ^ 0x5bf03635);

  /**
   * Round-robin across categories: take at most one person per category per
   * pass before taking a second from any. Mirrors autoSelectCaptains, including
   * its seeded shuffle — without the shuffle, an unlucky roster order can hand
   * the matcher a set it cannot seat.
   */
  const spread = (pool: number[], limit: number, seedCats: Set<string>): number[] => {
    const picked: number[] = [];
    const used = new Set(seedCats);
    const remaining = shuffle(pool, rng);

    while (picked.length < limit && remaining.length > 0) {
      let tookAny = false;
      for (let i = 0; i < remaining.length && picked.length < limit; i++) {
        if (used.has(categoryOf(remaining[i]))) continue;
        used.add(categoryOf(remaining[i]));
        picked.push(remaining[i]);
        remaining.splice(i, 1);
        i--;
        tookAny = true;
      }
      // Every remaining candidate's category is already represented. Reset the
      // per-pass filter and take one, then resume spreading.
      if (!tookAny) {
        used.clear();
        if (picked.length < limit) picked.push(remaining.shift()!);
      }
    }
    return picked;
  };

  // Too many captains: keep a category-spread subset of size T.
  if (designated.length > T) return spread(designated, T, new Set());

  // Too few: keep all designated, fill the rest preferring categories that
  // aren't already anchoring a table.
  const designatedSet = new Set(designated);
  const candidates = participants.map((p) => p.id).filter((id) => !designatedSet.has(id));
  const fill = spread(candidates, T - designated.length, new Set(designated.map(categoryOf)));

  return [...designated, ...fill];
}
