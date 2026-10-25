import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  messaging: new Proxy({}, { get: () => async () => "ok" }),
  auth: {},
}));

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, registrations, users, referrals, attendance } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const fb = await import("../feedback.service.js");
const stats = await import("../stats.service.js");

const as = <T>(uid: string, fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "mobile_app", actor: { uid, role: "member" }, changeCount: 0 }, fn);

let id = "";
beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE conclaves, users, settings CASCADE`);
  await pgdb.insert(users).values([
    { uid: "a", name: "A", lastLoginAt: new Date() },
    { uid: "b", name: "B" },
  ]);
  const [c] = await pgdb
    .insert(conclaves)
    .values({ name: "C", startDate: new Date(), status: "running", personsPerTable: 4, currentRound: 1, currentRoundStartedAt: new Date() })
    .returning();
  id = c.id;
  await pgdb.insert(registrations).values([
    { conclaveId: id, userId: "a", role: "captain" },
    { conclaveId: id, userId: "b", role: "member" },
  ]);
});
afterAll(async () => {
  await pool.end();
});

describe("feedback", () => {
  it("registered members only; resubmission overwrites and is audited", async () => {
    await expect(as("z", () => fb.submitFeedback(id, "z", { rating: 5 }))).rejects.toMatchObject({ status: 403 });
    await expect(as("a", () => fb.submitFeedback(id, "a", { rating: 9 }))).rejects.toMatchObject({ status: 400 });
    await as("a", () => fb.submitFeedback(id, "a", { rating: 4, timing: "right", comment: " good " }));
    await as("a", () => fb.submitFeedback(id, "a", { rating: 5, timing: "nonsense" }));
    await as("b", () => fb.submitFeedback(id, "b", { rating: 3 }));

    const list = await fb.listFeedback(id);
    expect(list).toMatchObject({ count: 2, avgRating: 4 });
    expect(list.items.find((i) => i.uid === "a")).toMatchObject({ rating: 5, timing: null });
    const rows = await pgdb.select().from(auditLog).where(and(eq(auditLog.entityId, `${id}:a`), eq(auditLog.conclaveId, id)));
    expect(rows.map((r) => r.action)).toEqual(["feedback.create", "feedback.update"]);
  });
});

describe("live stats", () => {
  it("counts from the database and uses the admin round timing", async () => {
    await pgdb.insert(referrals).values({ id: "r1", conclaveId: id, fromUserId: "a", toUserId: "b", roundNumber: 1 });
    await pgdb.insert(attendance).values({ id: "x1", conclaveId: id, userId: "b", roundNumber: 1, isPresent: true, source: "self" });
    const s = await stats.conclaveStats(id);
    expect(s.counts).toEqual({ registered: 2, active: 1, captains: 1, members: 1, referrals: 1, attendanceRecords: 1 });
    // Defaults: (60s bio + 30s referral) × 4 people = 6 min talking, + 2 min buffer.
    expect(s.roundActiveMs).toBe(360_000);
    expect(s.roundTransitionMs).toBe(120_000);
    expect(s.currentRoundComplete).toBe(false);
  });

  it("an unknown conclave is a 404, not an all-zero dashboard", async () => {
    await expect(stats.conclaveStats("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("registrations view does the captain arithmetic", async () => {
    const r = await stats.registrationsWithCounts(id);
    expect(r).toMatchObject({ rolesLocked: true, counts: { total: 2, captainsDesignated: 1, captainsRequired: 1 } });
  });
});
