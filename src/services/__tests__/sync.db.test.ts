import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const pushes: any[] = [];
vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  messaging: new Proxy({}, { get: () => async (...a: unknown[]) => { pushes.push(a); return "ok"; } }),
  auth: {},
}));

const { pgdb, pool } = await import("../../db/client.js");
const { attendance, auditLog, conclaves, referrals, registrations, users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const { generateForConclave } = await import("../schedule.service.js");
const { syncConclave } = await import("../sync.service.js");
const refs = await import("../referrals.service.js");

const as = <T>(uid: string, fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "mobile_app", actor: { uid, role: "member" }, changeCount: 0 }, fn);

let conclaveId = "";
// audit_log is append-only and persists across runs, so every audit lookup
// below is scoped to this run's conclave.
/** Round-1 seating: captain of table 1, a member at table 1, and someone at table 2. */
let cap = "", mate = "", other = "";
let roundStart = 0;

async function seed() {
  await pgdb.execute(sql`TRUNCATE conclaves, users, settings CASCADE`);
  const people = ["A", "B", "C", "D", "E", "F", "G"].map((n, i) => ({ uid: `u${n}`, name: n, category: `Cat${i}` }));
  await pgdb.insert(users).values(people);
  const [c] = await pgdb
    .insert(conclaves)
    .values({ name: "Live", venueLocation: "Hall", startDate: new Date(Date.now() + 86_400_000), status: "registrationClosed", personsPerTable: 4, roundCount: 4 })
    .returning();
  conclaveId = c.id;
  await pgdb.insert(registrations).values(people.map((p, i) => ({ conclaveId, userId: p.uid, role: i < 2 ? "captain" : "member" })));
  await as("admin", () => generateForConclave(conclaveId, {}));

  const [row] = await pgdb.select().from(conclaves).where(eq(conclaves.id, conclaveId));
  const parts = row.participants as any[];
  const uidOf = (pid: number) => parts.find((p) => p.id === pid)._originalUid;
  const t1 = (row.schedule as any).rounds[0].tables[0];
  const t2 = (row.schedule as any).rounds[0].tables[1];
  cap = uidOf(t1.captainId);
  mate = uidOf(t1.memberIds[0]);
  other = uidOf(t2.memberIds[0]);

  // Running, round 1 started 5 minutes ago → table of 4: talking 4 min, referrals 4:00–6:00.
  roundStart = Date.now() - 5 * 60_000;
  await pgdb.update(conclaves).set({ status: "running", currentRound: 1, currentRoundStartedAt: new Date(roundStart) }).where(eq(conclaves.id, conclaveId));
}

beforeAll(seed);
beforeEach(async () => {
  pushes.length = 0;
  await pgdb.execute(sql`DELETE FROM attendance; DELETE FROM referrals;`);
});
afterAll(async () => {
  await pool.end();
});

const att = (id: string, userId: string, markedBy: string, isPresent = true) => ({ id, userId, roundNumber: 1, isPresent, markedBy, timestamp: new Date().toISOString() });
const ref = (id: string, from: string, to: string, at = new Date(roundStart + 5 * 60_000)) => ({ id, roundNumber: 1, fromUserId: from, toUserId: to, notes: "n", timestamp: at.toISOString() });

describe("attendance", () => {
  it("accepts self-marks and a captain marking their own table; rejects (but acks) the rest", async () => {
    const r = await as(cap, () => syncConclave(conclaveId, cap, { attendance: [att("a1", cap, cap), att("a2", mate, cap), att("a3", other, cap)] }));
    expect(r.syncedAttendanceIds.sort()).toEqual(["a1", "a2", "a3"]);
    expect(r.errors.join(" ")).toMatch(/a3.*table you captain/);
    const saved = await pgdb.select().from(attendance);
    expect(saved.map((a) => a.id).sort()).toEqual(["a1", "a2"]);

    const forged = await as(mate, () => syncConclave(conclaveId, mate, { attendance: [att("a4", mate, cap)] }));
    expect(forged.errors.join(" ")).toMatch(/marks you made/);
  });

  it("a captain's mark beats a later self-mark", async () => {
    await as(cap, () => syncConclave(conclaveId, cap, { attendance: [att("m1", mate, cap, false)] }));
    await as(mate, () => syncConclave(conclaveId, mate, { attendance: [att("m1", mate, mate, true)] }));
    const [a] = await pgdb.select().from(attendance).where(eq(attendance.id, "m1"));
    expect(a).toMatchObject({ isPresent: false, source: "captain", markedBy: cap });
    expect(a.selfMark).toMatchObject({ isPresent: true, by: mate });
  });
});

describe("referrals", () => {
  it("accepts a giver's referral to a tablemate, pings once, and is idempotent", async () => {
    await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r1", mate, cap)] }));
    await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r1", mate, cap)] }));
    expect(await pgdb.select().from(referrals)).toHaveLength(1);
    const referralPushes = pushes.filter((p) => JSON.stringify(p).includes("referral_received"));
    expect(referralPushes).toHaveLength(1);
    const [a] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "referral.create"), eq(auditLog.entityId, "r1"), eq(auditLog.conclaveId, conclaveId)));
    expect(a.actorUid).toBe(mate);
  });

  it("rejects a referral the caller didn't give, or to someone they didn't sit with", async () => {
    const forged = await as(cap, () => syncConclave(conclaveId, cap, { referrals: [ref("r2", mate, cap)] }));
    expect(forged.errors.join(" ")).toMatch(/only the member giving/);
    const far = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r3", mate, other)] }));
    expect(far.errors.join(" ")).toMatch(/share a table/);
    expect(await pgdb.select().from(referrals)).toHaveLength(0);
  });

  it("current round: whole active phase allowed, after it refused; late past-round syncs kept; future refused", async () => {
    // Early in the round (someone's bio turn) is allowed — the app shows the
    // Refer button for the whole active phase.
    const early = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r4", mate, cap, new Date(roundStart + 10_000))] }));
    expect(early.errors).toEqual([]);
    // After the round's talking time (4 people × 90s = 6 min, +2 min slack) it's refused.
    const after = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r4b", mate, cap, new Date(roundStart + 9 * 60_000))] }));
    expect(after.errors.join(" ")).toMatch(/talking time ended/);

    // The conclave moves on to round 3; a round-1 referral arrives late → kept.
    await pgdb.update(conclaves).set({ currentRound: 3, currentRoundStartedAt: new Date() }).where(eq(conclaves.id, conclaveId));
    try {
      const late = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r5", mate, cap, new Date(roundStart + 10_000))] }));
      expect(late.errors).toEqual([]);
      expect(await pgdb.select().from(referrals).where(eq(referrals.id, "r5"))).toHaveLength(1);
    } finally {
      await pgdb.update(conclaves).set({ currentRound: 1, currentRoundStartedAt: new Date(roundStart) }).where(eq(conclaves.id, conclaveId));
    }

    // A referral for a round that hasn't started is refused.
    const future = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [{ ...ref("r9", mate, cap), roundNumber: 2 }] }));
    expect(future.errors.join(" ")).toMatch(/hasn't started|share a table/);

    // An old app build that sends no timestamp is never lost.
    const noTs = await as(mate, () => syncConclave(conclaveId, mate, { referrals: [{ ...ref("r6", mate, cap), timestamp: undefined }] }));
    expect(noTs.errors).toEqual([]);
  });

  it("only status changes after creation, and they're audited", async () => {
    await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r7", mate, cap)] }));
    await as(cap, () => syncConclave(conclaveId, cap, { referrals: [{ ...ref("r7", mate, cap), notes: "rewritten", status: "Accepted" }] }));
    const [r] = await pgdb.select().from(referrals).where(eq(referrals.id, "r7"));
    expect(r).toMatchObject({ notes: "n", status: "Accepted" });
    const [a] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "referral.status"), eq(auditLog.entityId, "r7"), eq(auditLog.conclaveId, conclaveId)));
    expect(a.changes).toMatchObject({ status: { from: "Pending", to: "Accepted" } });
  });

  it("members see only their own referrals; only the receiver records the outcome", async () => {
    await as(mate, () => syncConclave(conclaveId, mate, { referrals: [ref("r8", mate, cap)] }));
    expect(await refs.listMineInConclave(conclaveId, other)).toHaveLength(0);
    expect(await refs.listMineInConclave(conclaveId, cap)).toHaveLength(1);

    await expect(as(mate, () => refs.updateOutcome(conclaveId, "r8", mate, { outcome: "closed", amount: 5000 }))).rejects.toMatchObject({ status: 403 });
    await as(cap, () => refs.updateOutcome(conclaveId, "r8", cap, { outcome: "closed", amount: 5000 }));
    const mine = await refs.myReferrals(mate);
    expect(mine.given[0]).toMatchObject({ id: "r8", outcome: "closed", closedAmount: 5000, status: "Completed" });
  });
});

describe("state returned to the phone", () => {
  it("includes the member's schedule, table and audits the batch", async () => {
    const r = await as(mate, () => syncConclave(conclaveId, mate, { attendance: [att("s1", mate, mate)] }));
    expect(r.mySchedule).toHaveLength(4);
    expect(r.tableNumber).toBe(1);
    expect(r.conclaveStatus).toMatchObject({ id: conclaveId, status: "running", currentRound: 1 });
    const [a] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "attendance.sync"), eq(auditLog.actorUid, mate), eq(auditLog.conclaveId, conclaveId)));
    expect(a.metadata).toMatchObject({ marks: 1, selfMarks: 1 });
  });
});
