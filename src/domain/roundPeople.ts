import { MAX_PERSONS_PER_TABLE } from "./roundClock.js";

interface Table {
  captainId?: number | null;
  memberIds?: number[] | null;
}
interface Round {
  roundNumber: number;
  tables?: Table[] | null;
}

/**
 * Each round's clock size, index = round - 1: the larger of the conclave's
 * people-per-table and that round's biggest table (members + captain), never
 * above 8. A walk-in re-plan can make a later round's tables bigger; that
 * round's bios and referral slot grow with it, while the round in progress
 * keeps its own length.
 *
 * Stored on the conclave (`round_people`) in the same write as the schedule,
 * and read by the server clock, the live stream, the panel and the app.
 */
export function roundPeopleFor(schedule: { rounds?: Round[] | null } | null | undefined, personsPerTable: number | null | undefined): number[] | null {
  const rounds = schedule?.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  const base = Math.max(1, Number(personsPerTable) || 1);
  const count = Math.max(...rounds.map((r) => Number(r.roundNumber) || 0));
  const out: number[] = [];
  for (let k = 1; k <= count; k++) {
    const r = rounds.find((x) => Number(x.roundNumber) === k);
    const biggest = Math.max(
      0,
      ...(r?.tables ?? []).map((t) => (t.memberIds?.length ?? 0) + (t.captainId === null || t.captainId === undefined ? 0 : 1)),
    );
    out.push(Math.min(MAX_PERSONS_PER_TABLE, Math.max(base, biggest)));
  }
  return out;
}
