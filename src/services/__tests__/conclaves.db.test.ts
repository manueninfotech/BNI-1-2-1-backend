import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Push (FCM) and the deprecated Firestore handle are faked; data is real Postgres.
const pushes: unknown[] = [];
vi.mock("../../config/firebase.js", () => {
  const fn = async (...a: unknown[]) => {
    pushes.push(a);
    return "ok";
  };
  return {
    db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
    collections: { conclaves: "conclaves" },
    messaging: new Proxy({}, { get: () => fn }),
    auth: {},
  };
});

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, registrations, users, attendance } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const svc = await import("../conclave.service.js");
const { generateForConclave } = await import("../schedule.service.js");
const { sweepFinishedConclaves, isFinished } = await import("../autocomplete.service.js");
const { regionScope, assertRegion } = await import("../../middleware/conclaveAccess.js");

async function as<T>(uid: string, fn: () => Promise<T>) {
  const requestId = `t-${Math.random().toString(36).slice(2)}`;
  const result = await runWithContext({ requestId, source: "admin_panel", actor: { uid, role: "admin" }, changeCount: 0 }, fn);
  return { result, requestId };
}
const auditFor = (requestId: string) => pgdb.select().from(auditLog).where(eq(auditLog.requestId, requestId)).orderBy(auditLog.id);
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

async function makeConclave(over: Record<string, unknown> = {}) {
  const { result } = await as("admin-1", () =>
    svc.createConclave({ name: "C", venueLocation: "Hall", date: days(10), regStartDate: days(-1), regEndDate: days(5), personsPerTable: 4, roundCount: 4, region: "Guntur Region", ...over } as any),
  );
  return result;
}

/** 7 members in 7 categories, 2 designated captains → 2 tables of up to 4 (one spare seat). */
async function seedRoster(conclaveId: string) {
  const people = ["A", "B", "C", "D", "E", "F", "G"].map((n, i) => ({ uid: `u${n}`, name: n, category: `Cat${i}`, phone: `+91900000000${i}` }));
  await pgdb.insert(users).values(people);
  await pgdb.insert(registrations).values(
    people.map((p, i) => ({ conclaveId, userId: p.uid, role: i < 2 ? "captain" : "member" })),
  );
}

beforeEach(async () => {
  pushes.length = 0;
  await pgdb.execute(sql`TRUNCATE conclaves, users, settings CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("create / update", () => {
  it("rejects bad windows and audits a valid create", async () => {
    await expect(makeConclave({ date: days(-2) })).rejects.toMatchObject({ status: 400 });
    await expect(makeConclave({ regEndDate: days(20) })).rejects.toMatchObject({ status: 400 }); // reg closes after start
    await expect(makeConclave({ personsPerTable: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(makeConclave({ roundCount: 2 })).rejects.toMatchObject({ status: 400 }); // engine needs 4–8

    const { result: id, requestId } = await as("admin-1", () => svc.createConclave({ name: "Real", venueLocation: "Hall", date: days(10) } as any));
    const [row] = await auditFor(requestId);
    expect(row).toMatchObject({ action: "conclave.create", entityId: id, conclaveId: id, actorUid: "admin-1" });
    expect((await svc.getConclaveOrThrow(id)).data).toMatchObject({ name: "Real", status: "registrationOpen", isRegistrationOpen: true });
  });

  it("audits field-level changes and refuses edits once running", async () => {
    const id = await makeConclave();
    const { result: changed, requestId } = await as("admin-1", () => svc.updateConclave(id, { name: "Renamed", venueLocation: "Hall" }));
    expect(changed).toContain("name");
    expect((await auditFor(requestId))[0].changes).toEqual({ name: { from: "C", to: "Renamed" } });

    await pgdb.update(conclaves).set({ status: "running" }).where(eq(conclaves.id, id));
    await expect(as("admin-1", () => svc.updateConclave(id, { name: "X" }))).rejects.toMatchObject({ status: 409 });
  });

  it("locks table config once a schedule exists", async () => {
    const id = await makeConclave();
    await pgdb.update(conclaves).set({ schedule: { rounds: [] } }).where(eq(conclaves.id, id));
    await expect(as("admin-1", () => svc.updateConclave(id, { personsPerTable: 4 }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("lifecycle", () => {
  it("registration toggle and cancel follow the rules", async () => {
    const id = await makeConclave();
    await as("admin-1", () => svc.setRegistrationOpen(id, false));
    expect((await svc.getConclaveOrThrow(id)).row).toMatchObject({ registrationOverride: "closed", isRegistrationOpen: false });
    await as("admin-1", () => svc.cancelConclave(id));
    await expect(as("admin-1", () => svc.cancelConclave(id))).rejects.toMatchObject({ status: 409 });
    await expect(as("admin-1", () => svc.setRegistrationOpen(id, true))).rejects.toMatchObject({ status: 409 });
  });

  it("round 1 needs a schedule; one admin can't run two conclaves", async () => {
    const a = await makeConclave();
    const b = await makeConclave({ name: "B" });
    await expect(as("admin-1", () => svc.startRound(a, 1, "admin-1"))).rejects.toMatchObject({ status: 400 });

    await pgdb.update(conclaves).set({ schedule: { rounds: [] } });
    const { requestId } = await as("admin-1", () => svc.startRound(a, 1, "admin-1"));
    expect((await auditFor(requestId))[0]).toMatchObject({ action: "conclave.start", metadata: { roundNumber: 1 } });
    expect((await svc.getConclaveOrThrow(a)).row).toMatchObject({ status: "running", currentRound: 1, startedBy: "admin-1" });
    await expect(as("admin-1", () => svc.startRound(b, 1, "admin-1"))).rejects.toMatchObject({ status: 409 });
    expect(pushes.length).toBeGreaterThan(0);
  });

  it("rounds only move forward: no restarting, no skipping (manual and automatic)", async () => {
    const id = await makeConclave();
    await pgdb.update(conclaves).set({ schedule: { rounds: [] }, roundCount: 4 }).where(eq(conclaves.id, id));
    await as("admin-1", () => svc.startRound(id, 1, "admin-1"));
    // Manual (default): round 1 can't be restarted, round 3 can't be skipped to,
    // round 2 can be started whenever the admin is ready (even early).
    await expect(as("admin-1", () => svc.startRound(id, 1, "admin-1"))).rejects.toMatchObject({ status: 409 });
    await expect(as("admin-1", () => svc.startRound(id, 3, "admin-1"))).rejects.toMatchObject({ status: 400 });
    await as("admin-1", () => svc.startRound(id, 2, "admin-1"));
    // Automatic: the clock has moved on to a later round → an earlier one can't be started.
    await pgdb
      .update(conclaves)
      .set({ roundProgressionMode: "automatic", currentRoundStartedAt: new Date(Date.now() - 40 * 60_000) })
      .where(eq(conclaves.id, id));
    await expect(as("admin-1", () => svc.startRound(id, 3, "admin-1"))).rejects.toMatchObject({ status: 409 });
  });

  it("extending adds +1/+2/+5 min to the live round only; move time is 1/2/5 min", async () => {
    const id = await makeConclave();
    await pgdb.update(conclaves).set({ status: "running", currentRound: 1, roundCount: 4, personsPerTable: 8, currentRoundStartedAt: new Date(Date.now() - 60_000) }).where(eq(conclaves.id, id));
    await expect(as("admin-1", () => svc.extendRound(id, 180))).rejects.toMatchObject({ status: 400 });
    const { result } = await as("admin-1", () => svc.extendRound(id, 120));
    expect(result.roundExtensionSeconds).toBe(120);
    await as("admin-1", () => svc.extendRound(id, 300));
    expect((await svc.getConclaveOrThrow(id)).row.roundExtensionSeconds).toBe(420);
    await expect(as("admin-1", () => svc.setMoveSeconds(id, 90))).rejects.toMatchObject({ status: 400 });
    await as("admin-1", () => svc.setMoveSeconds(id, 300));
    expect((await svc.getConclaveOrThrow(id)).row.moveSeconds).toBe(300);
    // A round that has finished (manual mode, waiting for the admin) can't be extended.
    await pgdb.update(conclaves).set({ currentRoundStartedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(conclaves.id, id));
    await expect(as("admin-1", () => svc.extendRound(id, 60))).rejects.toMatchObject({ status: 409 });
  });

  it("switching to automatic mid-conclave starts the move break now, not in the past", async () => {
    const id = await makeConclave();
    // Manual round 1 finished 30 min ago and has been waiting for the admin.
    await pgdb.update(conclaves).set({ status: "running", currentRound: 1, roundCount: 4, personsPerTable: 8, moveSeconds: 120, currentRoundStartedAt: new Date(Date.now() - 42 * 60_000) }).where(eq(conclaves.id, id));
    await as("admin-1", () => svc.setProgressionMode(id, "automatic"));
    const { row } = await svc.getConclaveOrThrow(id);
    expect(row.roundProgressionMode).toBe("automatic");
    expect(row.currentRound).toBe(1); // didn't jump ahead
    // Round 1 now reads as just ended → round 2 starts after the 2-minute break.
    expect(Math.abs(Date.now() - row.currentRoundStartedAt!.getTime() - 12 * 60_000)).toBeLessThan(5_000);
  });

  it("pause and resume preserve the elapsed time", async () => {
    const id = await makeConclave();
    const started = new Date(Date.now() - 60_000);
    await pgdb.update(conclaves).set({ status: "running", currentRound: 1, currentRoundStartedAt: started }).where(eq(conclaves.id, id));
    const paused = await as("admin-1", () => svc.pauseRound(id));
    expect(paused.result.elapsedMs).toBeGreaterThanOrEqual(60_000);
    const resumed = await as("admin-1", () => svc.resumeRound(id));
    const anchor = (resumed.result as any).currentRoundStartedAt as Date;
    expect(Math.abs(Date.now() - anchor.getTime() - paused.result.elapsedMs!)).toBeLessThan(2_000);
    // Pausing twice is a no-op, not an error.
    await as("admin-1", () => svc.pauseRound(id));
    await expect(as("admin-1", () => svc.pauseRound(id))).resolves.toBeTruthy();
  });

  it("closing the last round completes the conclave", async () => {
    const id = await makeConclave();
    await pgdb.update(conclaves).set({ status: "running", currentRound: 2, roundCount: 2, currentRoundStartedAt: new Date() }).where(eq(conclaves.id, id));
    const { result } = await as("admin-1", () => svc.closeRound(id));
    expect(result).toMatchObject({ finalRound: 2, roundCount: 2, endedEarly: false });
    expect((await svc.getConclaveOrThrow(id)).row.status).toBe("completed");
  });
});

describe("list / delete", () => {
  it("filters by region and counts registrations", async () => {
    const g = await makeConclave();
    await makeConclave({ name: "Vizag", region: "Visakhapatnam Region" });
    await seedRoster(g);
    const guntur = await svc.listConclaves("guntur");
    expect(guntur.map((c) => c.name)).toEqual(["C"]);
    expect(guntur[0].registrationCount).toBe(7);
    expect(await svc.listConclaves()).toHaveLength(2);
  });

  it("delete cascades to child data and is audited with counts", async () => {
    const id = await makeConclave();
    await seedRoster(id);
    await pgdb.insert(attendance).values({ id: "a1", conclaveId: id, userId: "uA", roundNumber: 1, isPresent: true, source: "self" });
    const { requestId } = await as("admin-1", () => svc.deleteConclave(id));
    expect(await pgdb.select().from(registrations).where(eq(registrations.conclaveId, id))).toHaveLength(0);
    expect(await pgdb.select().from(attendance).where(eq(attendance.conclaveId, id))).toHaveLength(0);
    expect((await auditFor(requestId))[0]).toMatchObject({ action: "conclave.delete", metadata: { registrations: 7, op: "delete" } });
  });
});

describe("schedule generation", () => {
  it("seats the roster, updates registrations and audits a summary", async () => {
    const id = await makeConclave();
    await seedRoster(id);
    const { result, requestId } = await as("admin-1", () => generateForConclave(id, {}));
    expect(result).toMatchObject({ tableCount: 2, captains: 2, participants: 7 });

    const regs = await pgdb.select().from(registrations).where(eq(registrations.conclaveId, id));
    expect(regs.filter((r) => r.role === "captain").map((r) => r.tableNumber).sort()).toEqual([1, 2]);
    expect(regs.every((r) => r.participantId !== null)).toBe(true);

    const [row] = await auditFor(requestId);
    expect(row).toMatchObject({ action: "schedule.generate", metadata: { participants: 7, captains: 2, regenerated: false } });
  });

  it("closes registration, and seats extra captains as members for the whole conclave", async () => {
    const id = await makeConclave();
    await seedRoster(id);
    // 3 captains for a 2-table roster: the system keeps 2 anchors (best category mix).
    const [extra] = await pgdb.select().from(registrations).where(and(eq(registrations.conclaveId, id), eq(registrations.role, "member"))).limit(1);
    await pgdb.update(registrations).set({ role: "captain" }).where(and(eq(registrations.conclaveId, id), eq(registrations.userId, extra.userId)));
    await as("admin-1", () => generateForConclave(id, {}));

    const regs = await pgdb.select().from(registrations).where(eq(registrations.conclaveId, id));
    expect(regs.filter((r) => r.role === "captain")).toHaveLength(2);
    expect(regs.filter((r) => r.role === "member")).toHaveLength(5);
    const { row } = await svc.getConclaveOrThrow(id);
    expect(row).toMatchObject({ isRegistrationOpen: false, registrationOverride: "closed", status: "registrationClosed" });
  });

  it("explains a captain-count mismatch and refuses to regenerate while running", async () => {
    const id = await makeConclave();
    await seedRoster(id);
    await pgdb.update(registrations).set({ role: "member" }).where(and(eq(registrations.conclaveId, id), eq(registrations.userId, "uA")));
    await expect(as("admin-1", () => generateForConclave(id, {}))).rejects.toMatchObject({ status: 400, details: { captainsRequired: 2, captainsDesignated: 1 } });

    await pgdb.update(conclaves).set({ status: "running" }).where(eq(conclaves.id, id));
    await expect(as("admin-1", () => generateForConclave(id, { autoFillCaptains: true }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("auto-complete sweep", () => {
  it("completes a conclave once its last round's time is over; never mid-way or while paused", async () => {
    const lastDone = await makeConclave({ name: "Last round over" });
    const waiting = await makeConclave({ name: "Manual, waiting for round 2" });
    const autoDone = await makeConclave({ name: "Automatic, all rounds over" });
    const live = await makeConclave({ name: "Live" });
    const paused = await makeConclave({ name: "Paused on last round" });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const base = { status: "running", roundCount: 2, personsPerTable: 8 } as const;
    await pgdb.update(conclaves).set({ ...base, currentRound: 2, currentRoundStartedAt: hoursAgo(1) }).where(eq(conclaves.id, lastDone));
    await pgdb.update(conclaves).set({ ...base, currentRound: 1, currentRoundStartedAt: hoursAgo(5) }).where(eq(conclaves.id, waiting));
    await pgdb.update(conclaves).set({ ...base, roundProgressionMode: "automatic", currentRound: 1, currentRoundStartedAt: hoursAgo(1) }).where(eq(conclaves.id, autoDone));
    await pgdb.update(conclaves).set({ ...base, currentRound: 2, currentRoundStartedAt: new Date() }).where(eq(conclaves.id, live));
    await pgdb.update(conclaves).set({ ...base, currentRound: 2, currentRoundStartedAt: hoursAgo(1), isRoundPaused: true, roundElapsedMsBeforePause: 60_000 }).where(eq(conclaves.id, paused));

    expect(await sweepFinishedConclaves()).toBe(2);
    expect((await svc.getConclaveOrThrow(lastDone)).row).toMatchObject({ status: "completed", currentRound: 2 });
    expect((await svc.getConclaveOrThrow(autoDone)).row).toMatchObject({ status: "completed", currentRound: 2 });
    for (const id of [waiting, live, paused]) expect((await svc.getConclaveOrThrow(id)).row.status).toBe("running");
    const [a] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "conclave.auto_complete"), eq(auditLog.entityId, lastDone)));
    expect(a).toBeTruthy();
  });

  it("isFinished: a 'running' conclave with no round anchor is over once its day has passed", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    expect(
      isFinished({ currentRoundStartedAt: null, currentRound: 0, roundCount: 4, personsPerTable: 5, startDate: twoDaysAgo, endDate: null, isRoundPaused: false, roundElapsedMsBeforePause: null, roundProgressionMode: "manual", roundExtensionSeconds: 0, moveSeconds: 120 }),
    ).toBe(true);
  });
});

describe("regional access", () => {
  const admin = (role: string, region: string | null) => ({ uid: "x", role, region, email: "", name: "", status: "Active" }) as any;
  it("superadmin and Global admins see all; others only their region", () => {
    expect(regionScope(admin("superadmin", "Guntur Region"))).toBeNull();
    expect(regionScope(admin("admin", "Global"))).toBeNull();
    expect(regionScope(admin("coordinator", "Guntur Region"))).toBe("Guntur Region");
    expect(() => assertRegion(admin("coordinator", "Guntur Region"), "guntur")).not.toThrow();
    expect(() => assertRegion(admin("coordinator", "Guntur Region"), "Visakhapatnam Region")).toThrow(/assigned region/);
    expect(() => assertRegion(admin("coordinator", null), "Guntur Region")).toThrow(/assigned to a region/);
  });
});
