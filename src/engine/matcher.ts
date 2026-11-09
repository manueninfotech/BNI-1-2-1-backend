// Schedule generation (spec §7). Social-golfer rotation with a hard
// business-category coloring constraint.
//
// Rules:
//   - Captains are fixed table anchors (one per table, all rounds). A table may
//     also have no anchor (captainless conclaves).
//   - Business-category separation (C1) is HARD and never violated.
//   - Tables are BALANCED (organisers' rule): with A people at T tables, every
//     table seats floor(A/T) or ceil(A/T), never more than P. 26 people at 5 per
//     table -> 6 tables of 5,5,4,4,4,4.
//   - Repeat pairings (C2) are SOFT: minimised, allowed only if forced.
//   - Objective: maximise the number of DISTINCT people each member meets.
//
// Method, per round:
//   1. Greedy: most-constrained members first, each to the category-safe table
//      with the fewest people they have already met (ties: emptier table).
//   2. Repair when a member has no safe seat: move one member out of a table
//      (to another safe table with room) so the newcomer fits.
//   3. Retry with a fresh seeded order if the round still dead-ends.
//   4. Improve: swap pairs of members between tables whenever that lowers the
//      round's repeat total (C1 and table sizes stay intact by construction).
//
// Mid-event re-planning: `planSchedule` keeps the rounds already played exactly
// as they were, counts who has met whom in them, and plans only the rest — the
// path walk-ins and new tables take.
//
// Efficiency: ids map to dense indices; "how often have these two met?" is an
// O(1) lookup in one Uint8Array (A*A bytes: 25 MB at 5,000 people); table
// categories are a flat counter array. Deterministic for a given seed.

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

/** One table to plan: its number and its fixed anchor (null = no captain). */
export interface PlanTable {
  tableNumber: number;
  captainId: number | null;
}

export interface PlanInput {
  participants: Participant[];
  tables: PlanTable[];
  config: ConclaveConfig;
  /** Rounds already played, kept verbatim (their pairings count as "met"). */
  history?: RoundSeating[];
  /** First round to plan (default 1). Rounds before it come from `history`. */
  fromRound?: number;
}

const BALANCED_ATTEMPTS = 24;
const RELAXED_ATTEMPTS = 12;
const IMPROVE_PASSES = 3;
const SWAP_SAMPLE_TABLES = 16;

/** Classic entry point: captains anchor tables 1..T in order. */
export function generateSchedule(
  participants: Participant[],
  captainIds: number[],
  config: ConclaveConfig,
): Schedule {
  return planSchedule({
    participants,
    tables: captainIds.map((captainId, i) => ({ tableNumber: i + 1, captainId })),
    config,
  });
}

export function planSchedule(input: PlanInput): Schedule {
  const { participants, config } = input;
  const A = participants.length;
  const P = config.personsPerTable;
  const fromRound = Math.max(1, input.fromRound ?? 1);
  const T = input.tables.length;

  // --- dense index mapping --------------------------------------------------
  const idToIdx = new Map<number, number>();
  participants.forEach((p, i) => idToIdx.set(p.id, i));

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
  const C = Math.max(1, catToIdx.size);

  const anchorIdx = new Int32Array(T).fill(-1);
  const anchorSet = new Set<number>();
  input.tables.forEach((t, i) => {
    if (t.captainId === null) return;
    const idx = idToIdx.get(t.captainId);
    if (idx === undefined) throw new Error(`Captain id ${t.captainId} not in participants.`);
    if (anchorSet.has(idx)) throw new Error(`Captain id ${t.captainId} anchors two tables.`);
    anchorIdx[i] = idx;
    anchorSet.add(idx);
  });
  const memberIdxs: number[] = [];
  for (let i = 0; i < A; i++) if (!anchorSet.has(i)) memberIdxs.push(i);

  const catFreq = new Int32Array(C);
  for (let i = 0; i < A; i++) catFreq[catIdxOf[i]]++;

  // --- meeting counts (history first) ----------------------------------------
  const met = new Uint8Array(A * A);
  const meet = (occ: number[]) => {
    for (let a = 0; a < occ.length; a++) {
      for (let b = a + 1; b < occ.length; b++) {
        const x = occ[a];
        const y = occ[b];
        if (met[x * A + y] < 255) {
          met[x * A + y]++;
          met[y * A + x]++;
        }
      }
    }
  };

  const rounds: RoundSeating[] = [];
  for (const r of input.history ?? []) {
    if (r.roundNumber >= fromRound) continue;
    rounds.push(r);
    for (const t of r.tables) {
      const occ: number[] = [];
      for (const id of [t.captainId, ...t.memberIds]) {
        const idx = id === null || id === undefined ? undefined : idToIdx.get(id);
        if (idx !== undefined) occ.push(idx);
      }
      meet(occ);
    }
  }

  // --- plan the remaining rounds ---------------------------------------------
  const ctx: RoundCtx = { A, T, P, C, catIdxOf, anchorIdx, memberIdxs, catFreq, met };
  for (let r = fromRound; r <= config.roundCount; r++) {
    const tables = planRound(ctx, config.seed, r);
    for (const occ of tables) meet(occ);
    rounds.push(toRoundSeating(r, tables, input.tables, anchorIdx, participants));
  }
  rounds.sort((a, b) => a.roundNumber - b.roundNumber);

  const stats = computeStats(A, T, config.roundCount, met);
  return { config, tableCount: T, rounds, stats };
}

// ---------------------------------------------------------------------------

interface RoundCtx {
  A: number;
  T: number;
  P: number;
  C: number;
  catIdxOf: Int32Array;
  anchorIdx: Int32Array;
  memberIdxs: number[];
  catFreq: Int32Array;
  met: Uint8Array;
}

/** Plans one round; returns each table's occupants (anchor first, if any). */
function planRound(ctx: RoundCtx, seed: number, r: number): number[][] {
  const { A, T, P } = ctx;
  if (T === 0) throw new InfeasibleRoundError(r, -1, `Round ${r}: no tables to seat anyone at.`);
  const base = Math.floor(A / T);
  const extra = A % T;
  if (base + (extra > 0 ? 1 : 0) > P) {
    throw new InfeasibleRoundError(r, -1, `Round ${r}: ${A} people cannot fit ${T} tables of ${P}.`);
  }

  // Balanced first; only if that is impossible, fall back to "never above P".
  for (const balanced of [true, false]) {
    const attempts = balanced ? BALANCED_ATTEMPTS : RELAXED_ATTEMPTS;
    for (let k = 0; k < attempts; k++) {
      const rng = makeRng(seed + r * 0x1000193 + k * 0x9e3779b1);
      const seating = tryRound(ctx, rng, balanced ? { base, extra } : null);
      if (seating) {
        improve(ctx, seating, rng);
        return seating.occ;
      }
    }
  }
  throw new InfeasibleRoundError(
    r,
    -1,
    `Round ${r}: no category-safe seating found. A business category probably has more people than there are tables.`,
  );
}

interface Seating {
  occ: number[][];
  tableOf: Int32Array;
  cats: Uint16Array; // T * C counters
  ceilUsed: number;
  limit: { base: number; extra: number } | null;
}

function tryRound(ctx: RoundCtx, rng: Rng, limit: { base: number; extra: number } | null): Seating | null {
  const { A, T, C, catIdxOf, anchorIdx, memberIdxs, catFreq } = ctx;
  const s: Seating = {
    occ: Array.from({ length: T }, () => [] as number[]),
    tableOf: new Int32Array(A).fill(-1),
    cats: new Uint16Array(T * C),
    ceilUsed: 0,
    limit,
  };
  for (let t = 0; t < T; t++) if (anchorIdx[t] >= 0) add(ctx, s, anchorIdx[t], t);

  const ordered = stableSortByDesc(shuffle(memberIdxs, rng), (m) => catFreq[catIdxOf[m]]);
  const tableOrder = shuffle(
    Array.from({ length: T }, (_, i) => i),
    rng,
  );

  for (const m of ordered) {
    const best = bestTable(ctx, s, m, tableOrder);
    if (best >= 0) {
      add(ctx, s, m, best);
      continue;
    }
    if (!repair(ctx, s, m, tableOrder)) return null;
  }
  return s;
}

function hasRoom(ctx: RoundCtx, s: Seating, t: number): boolean {
  const n = s.occ[t].length;
  if (!s.limit) return n < ctx.P;
  const { base, extra } = s.limit;
  return n < base || (n === base && s.ceilUsed < extra);
}

function safe(ctx: RoundCtx, s: Seating, m: number, t: number): boolean {
  return s.cats[t * ctx.C + ctx.catIdxOf[m]] === 0;
}

function add(ctx: RoundCtx, s: Seating, m: number, t: number) {
  if (s.limit && s.occ[t].length === s.limit.base) s.ceilUsed++;
  s.occ[t].push(m);
  s.tableOf[m] = t;
  s.cats[t * ctx.C + ctx.catIdxOf[m]]++;
}

function remove(ctx: RoundCtx, s: Seating, m: number) {
  const t = s.tableOf[m];
  const occ = s.occ[t];
  occ.splice(occ.indexOf(m), 1);
  if (s.limit && occ.length === s.limit.base) s.ceilUsed--;
  s.tableOf[m] = -1;
  s.cats[t * ctx.C + ctx.catIdxOf[m]]--;
}

/** Repeat cost of seating m with table t's occupants (skipping `except`). */
function cost(ctx: RoundCtx, s: Seating, m: number, t: number, except = -1): number {
  const row = m * ctx.A;
  let c = 0;
  for (const o of s.occ[t]) if (o !== except && o !== m) c += ctx.met[row + o];
  return c;
}

function bestTable(ctx: RoundCtx, s: Seating, m: number, order: number[]): number {
  let best = -1;
  let bestCost = Infinity;
  let bestSize = Infinity;
  for (const t of order) {
    if (!hasRoom(ctx, s, t) || !safe(ctx, s, m, t)) continue;
    const c = cost(ctx, s, m, t);
    const n = s.occ[t].length;
    if (c < bestCost || (c === bestCost && n < bestSize)) {
      best = t;
      bestCost = c;
      bestSize = n;
    }
  }
  return best;
}

/**
 * m has no safe table with room. Find a table t where, once one of its members
 * x leaves (to another safe table d with room), m is safe and fits. Covers both
 * "blocked by a same-category member" and "the only safe tables are full" (the
 * exact-fit dead end). Table sizes stay valid: t loses x and gains m.
 */
function repair(ctx: RoundCtx, s: Seating, m: number, order: number[]): boolean {
  const catM = ctx.catIdxOf[m];
  let bestT = -1;
  let bestX = -1;
  let bestDest = -1;
  let bestCost = Infinity;

  for (const t of order) {
    const sameCat = s.cats[t * ctx.C + catM];
    if (sameCat > 1) continue; // two to evict — not a one-move repair
    for (const x of s.occ[t]) {
      if (ctx.anchorIdx[t] === x) continue; // anchors never move
      if (sameCat === 1 && ctx.catIdxOf[x] !== catM) continue; // must evict the blocker
      for (const d of order) {
        if (d === t) continue;
        if (!hasRoom(ctx, s, d) || !safe(ctx, s, x, d)) continue;
        const c = cost(ctx, s, m, t, x) + cost(ctx, s, x, d);
        if (c < bestCost) {
          bestCost = c;
          bestT = t;
          bestX = x;
          bestDest = d;
        }
        break; // first safe destination for this x is enough
      }
    }
  }
  if (bestT < 0) return false;
  remove(ctx, s, bestX);
  add(ctx, s, bestX, bestDest);
  add(ctx, s, m, bestT);
  return true;
}

/** Swap members between tables while it lowers the round's repeat total. */
function improve(ctx: RoundCtx, s: Seating, rng: Rng) {
  const { T, C, catIdxOf, anchorIdx } = ctx;
  if (T < 2) return;
  for (let pass = 0; pass < IMPROVE_PASSES; pass++) {
    let improved = false;
    for (let a = 0; a < T; a++) {
      for (const m of [...s.occ[a]]) {
        if (anchorIdx[a] === m || s.tableOf[m] !== a) continue;
        const cm = cost(ctx, s, m, a);
        if (cm === 0) continue; // no repeats for m here
        const catM = catIdxOf[m];
        const sample = Math.min(T - 1, SWAP_SAMPLE_TABLES);
        let done = false;
        for (let k = 0; k < sample && !done; k++) {
          const b = (a + 1 + Math.floor(rng() * (T - 1))) % T;
          for (const x of s.occ[b]) {
            if (anchorIdx[b] === x) continue;
            const catX = catIdxOf[x];
            // C1 after the swap: b without x must not hold catM; a without m must not hold catX.
            if (catX !== catM && (s.cats[b * C + catM] > 0 || s.cats[a * C + catX] > 0)) continue;
            const before = cm + cost(ctx, s, x, b);
            const after = cost(ctx, s, m, b, x) + cost(ctx, s, x, a, m);
            if (after < before) {
              remove(ctx, s, m);
              remove(ctx, s, x);
              add(ctx, s, m, b);
              add(ctx, s, x, a);
              improved = true;
              done = true;
              break;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
}

function toRoundSeating(
  roundNumber: number,
  occ: number[][],
  tables: PlanTable[],
  anchorIdx: Int32Array,
  participants: Participant[],
): RoundSeating {
  const seats: TableSeating[] = occ.map((o, t) => {
    const anchor = anchorIdx[t];
    return {
      tableNumber: tables[t].tableNumber,
      captainId: tables[t].captainId,
      memberIds: o.filter((i) => i !== anchor).map((i) => participants[i].id),
    };
  });
  return { roundNumber, tables: seats };
}

function computeStats(A: number, tableCount: number, rounds: number, met: Uint8Array): ScheduleStats {
  let uniquePairsMet = 0;
  let repeatPairings = 0;
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < A; i++) {
    let d = 0;
    const row = i * A;
    for (let j = 0; j < A; j++) {
      const c = met[row + j];
      if (c === 0) continue;
      d++;
      if (j > i) {
        uniquePairsMet++;
        repeatPairings += c - 1;
      }
    }
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
