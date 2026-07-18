// Schedule generation (spec §7). Social-golfer rotation with a hard
// business-category coloring constraint.
//
// Decisions baked in:
//   - Captains are fixed table anchors (one per table, all rounds).
//   - Business-category separation (C1) is HARD and never violated.
//   - Repeat pairings (C2) are SOFT: minimized, allowed only if forced.
//   - Objective: maximize the number of DISTINCT people each member meets.
//
// Efficiency:
//   - Ids are mapped to dense indices [0..A).
//   - "Have these two met?" is an O(1) lookup in a single Uint8Array bit-matrix
//     (A*A bytes; ~88KB at A=300), so the hot path does no Set hashing.
//   - Per round the work is O(A * T) for placement plus O(T * P^2) to record
//     pairings — linear in the schedule size.

import {
  type ConclaveConfig,
  type Participant,
  type RoundSeating,
  type Schedule,
  type ScheduleStats,
  type TableSeating,
} from "./types.js";
import { makeRng, shuffle, type Rng } from "./rng.js";

export class InfeasibleRoundError extends Error {
  constructor(
    public roundNumber: number,
    public participantId: number,
    message: string,
  ) {
    super(message);
    this.name = "InfeasibleRoundError";
  }
}

interface WorkingTable {
  tableNumber: number;
  captainIdx: number;
  occupants: number[]; // dense indices, occupants[0] === captainIdx
  cats: Set<number>; // category indices currently present
}

export function generateSchedule(
  participants: Participant[],
  captainIds: number[],
  config: ConclaveConfig,
): Schedule {
  const A = participants.length;
  const P = config.personsPerTable;

  // --- dense index mapping --------------------------------------------------
  const idToIdx = new Map<number, number>();
  participants.forEach((p, i) => idToIdx.set(p.id, i));

  // category -> index
  const catToIdx = new Map<string, number>();
  const catIdxOf = new Int32Array(A);
  for (let i = 0; i < A; i++) {
    const c = participants[i].businessCategory;
    let ci = catToIdx.get(c);
    if (ci === undefined) {
      ci = catToIdx.size;
      catToIdx.set(c, ci);
    }
    catIdxOf[i] = ci;
  }

  const captainIdxs = captainIds.map((id) => {
    const idx = idToIdx.get(id);
    if (idx === undefined) throw new Error(`Captain id ${id} not in participants.`);
    return idx;
  });
  const captainIdxSet = new Set(captainIdxs);
  const memberIdxs: number[] = [];
  for (let i = 0; i < A; i++) if (!captainIdxSet.has(i)) memberIdxs.push(i);

  // global category frequency, used to order most-constrained members first
  const catFreq = new Int32Array(catToIdx.size);
  for (let i = 0; i < A; i++) catFreq[catIdxOf[i]]++;

  // --- met bit-matrix -------------------------------------------------------
  const met = new Uint8Array(A * A);
  const degree = new Int32Array(A); // distinct people each index has met
  let uniquePairsMet = 0;
  let repeatPairings = 0;

  const rounds: RoundSeating[] = [];

  for (let r = 1; r <= config.roundCount; r++) {
    const roundRng = makeRng(config.seed + r * 0x1000193);
    const tables = buildTables(captainIdxs, catIdxOf);

    // Order members: most-constrained category first, shuffled within for
    // cross-round variety. A higher global category frequency means more
    // tables are likely already blocked, so seat those people earlier.
    const ordered = stableSortByDesc(shuffle(memberIdxs, roundRng), (m) => catFreq[catIdxOf[m]]);

    const tableOrder = shuffle(
      tables.map((_, i) => i),
      roundRng,
    );

    for (const m of ordered) {
      placeMember(m, tables, tableOrder, catIdxOf, met, A, P, r);
    }

    // Record pairings for this completed round.
    for (const t of tables) {
      const occ = t.occupants;
      for (let a = 0; a < occ.length; a++) {
        for (let b = a + 1; b < occ.length; b++) {
          const x = occ[a];
          const y = occ[b];
          const key = x * A + y;
          if (met[key]) {
            repeatPairings++;
          } else {
            met[key] = 1;
            met[y * A + x] = 1;
            degree[x]++;
            degree[y]++;
            uniquePairsMet++;
          }
        }
      }
    }

    rounds.push(toRoundSeating(r, tables, participants));
  }

  const stats = computeStats(A, captainIdxs.length, config.roundCount, degree, uniquePairsMet, repeatPairings);

  return { config, tableCount: captainIdxs.length, rounds, stats };
}

function buildTables(captainIdxs: number[], catIdxOf: Int32Array): WorkingTable[] {
  return captainIdxs.map((c, i) => ({
    tableNumber: i + 1,
    captainIdx: c,
    occupants: [c],
    cats: new Set<number>([catIdxOf[c]]),
  }));
}

function placeMember(
  m: number,
  tables: WorkingTable[],
  tableOrder: number[],
  catIdxOf: Int32Array,
  met: Uint8Array,
  A: number,
  P: number,
  roundNumber: number,
): void {
  const cat = catIdxOf[m];
  let best = -1;
  let bestRepeat = Infinity;
  let bestFree = -1;

  for (const ti of tableOrder) {
    const t = tables[ti];
    if (t.occupants.length >= P) continue; // C4
    if (t.cats.has(cat)) continue; // C1 hard

    // repeat cost = how many current occupants this member has already met
    let repeat = 0;
    const base = m * A;
    for (const o of t.occupants) if (met[base + o]) repeat++;
    const free = P - t.occupants.length;

    // minimize repeats (C2), then prefer emptier tables for balance
    if (repeat < bestRepeat || (repeat === bestRepeat && free > bestFree)) {
      best = ti;
      bestRepeat = repeat;
      bestFree = free;
    }
  }

  if (best === -1) {
    if (!repair(m, tables, catIdxOf, P)) {
      throw new InfeasibleRoundError(
        roundNumber,
        m,
        `Round ${roundNumber}: no category-safe table for participant index ${m}. ` +
          `This usually means a V11 feasibility violation slipped through.`,
      );
    }
    return;
  }

  const t = tables[best];
  t.occupants.push(m);
  t.cats.add(cat);
}

/**
 * Repair step: m has no open category-safe table. Find a table with a free
 * seat that is blocked only because a *member* there shares m's category;
 * relocate that blocker to another safe table, then seat m. Keeps C1 intact.
 */
function repair(m: number, tables: WorkingTable[], catIdxOf: Int32Array, P: number): boolean {
  const cat = catIdxOf[m];
  for (const t of tables) {
    if (t.occupants.length >= P) continue;
    if (!t.cats.has(cat)) continue; // would have been a candidate already

    // blocker = a non-captain occupant whose category equals m's
    const blockerPos = t.occupants.findIndex((o, pos) => pos > 0 && catIdxOf[o] === cat);
    if (blockerPos === -1) continue; // blocked by the captain — cannot move
    const blocker = t.occupants[blockerPos];
    const blockerCat = catIdxOf[blocker];

    const alt = tables.find(
      (t2) => t2 !== t && t2.occupants.length < P && !t2.cats.has(blockerCat),
    );
    if (!alt) continue;

    // move blocker -> alt
    t.occupants.splice(blockerPos, 1);
    rebuildCats(t, catIdxOf);
    alt.occupants.push(blocker);
    alt.cats.add(blockerCat);

    // seat m at t
    t.occupants.push(m);
    t.cats.add(cat);
    return true;
  }
  return false;
}

function rebuildCats(t: WorkingTable, catIdxOf: Int32Array): void {
  t.cats = new Set(t.occupants.map((o) => catIdxOf[o]));
}

function toRoundSeating(
  roundNumber: number,
  tables: WorkingTable[],
  participants: Participant[],
): RoundSeating {
  const seats: TableSeating[] = tables.map((t) => ({
    tableNumber: t.tableNumber,
    captainId: participants[t.captainIdx].id,
    memberIds: t.occupants.slice(1).map((o) => participants[o].id),
  }));
  return { roundNumber, tables: seats };
}

function computeStats(
  A: number,
  tableCount: number,
  rounds: number,
  degree: Int32Array,
  uniquePairsMet: number,
  repeatPairings: number,
): ScheduleStats {
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < A; i++) {
    const d = degree[i];
    sum += d;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const totalPairsPossible = (A * (A - 1)) / 2;
  return {
    participants: A,
    tables: tableCount,
    rounds,
    totalPairsPossible,
    uniquePairsMet,
    repeatPairings,
    avgUniqueMetPerMember: A > 0 ? sum / A : 0,
    minUniqueMetPerMember: A > 0 ? min : 0,
    maxUniqueMetPerMember: max,
    coverage: totalPairsPossible > 0 ? uniquePairsMet / totalPairsPossible : 0,
  };
}

// Stable sort by a numeric key, descending. Preserves input order on ties so
// the seeded shuffle (applied beforehand) drives tie-breaking deterministically.
function stableSortByDesc<T>(arr: T[], key: (x: T) => number): T[] {
  return arr
    .map((v, i) => ({ v, i, k: key(v) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map((x) => x.v);
}

export type { Rng };
