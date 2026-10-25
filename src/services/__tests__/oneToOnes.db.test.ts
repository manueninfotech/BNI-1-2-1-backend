import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const pushes: any[] = [];
vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  messaging: new Proxy({}, { get: () => async (...a: unknown[]) => { pushes.push(a); return "ok"; } }),
  auth: {},
}));

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, oneToOnes, registrations, users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const svc = await import("../oneToOnes.service.js");
const { listForMember } = await import("../conclave.service.js");

const as = <T>(uid: string, fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "mobile_app", actor: { uid, role: "member" }, changeCount: 0 }, fn);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(async () => {
  pushes.length = 0;
  await pgdb.execute(sql`TRUNCATE users, one_to_ones, conclaves CASCADE`);
  await pgdb.insert(users).values([
    { uid: "a", name: "Asha", company: "Glass", phone: "+919000000001", email: "asha@x.com" },
    { uid: "b", name: "Bala", company: "Wood", phone: "+919000000002" },
  ]);
});
afterAll(async () => {
  await pool.end();
});

describe("1-2-1 requests", () => {
  it("creates (audited), notifies the invitee, and lists for both sides", async () => {
    const { id } = await as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(24), location: "Cafe" }));
    expect(pushes.length).toBeGreaterThan(0);
    const [audit] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "one_to_one.create"), eq(auditLog.entityId, id)));
    expect(audit.actorUid).toBe("a");
    expect((await svc.listMine("a")).oneToOnes[0]).toMatchObject({ direction: "sent", otherName: "Bala", otherBusinessName: "Wood", status: "pending" });
    expect((await svc.listMine("b")).oneToOnes[0]).toMatchObject({ direction: "received", otherName: "Asha" });
  });

  it("validates input and limits spam", async () => {
    await expect(as("a", () => svc.create("a", { toUserId: "a", proposedAt: inHours(1) }))).rejects.toMatchObject({ status: 400 });
    await expect(as("a", () => svc.create("a", { toUserId: "b", proposedAt: "nope" }))).rejects.toMatchObject({ status: 400 });
    await expect(as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(-3) }))).rejects.toMatchObject({ status: 400 });
    await expect(as("a", () => svc.create("a", { toUserId: "ghost", proposedAt: inHours(1) }))).rejects.toMatchObject({ status: 404 });

    const { id } = await as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(24) }));
    await expect(as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(25) }))).rejects.toMatchObject({ status: 409 });
    await as("b", () => svc.respond("b", id, "declined"));
    await as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(26) }));
    const [{ id: id2 }] = await pgdb.select({ id: oneToOnes.id }).from(oneToOnes).where(eq(oneToOnes.status, "pending"));
    await as("b", () => svc.respond("b", id2, "declined"));
    await expect(as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(27) }))).rejects.toMatchObject({ status: 429 });
  });

  it("enforces who may respond and the status machine", async () => {
    const { id } = await as("a", () => svc.create("a", { toUserId: "b", proposedAt: inHours(24) }));
    await expect(as("a", () => svc.respond("a", id, "accepted"))).rejects.toMatchObject({ status: 403 });
    await expect(as("x", () => svc.respond("x", id, "cancelled"))).rejects.toMatchObject({ status: 403 });
    await as("b", () => svc.respond("b", id, "declined"));
    await expect(as("b", () => svc.respond("b", id, "accepted"))).rejects.toMatchObject({ status: 409 });
    const [row] = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "one_to_one.declined"), eq(auditLog.entityId, id)));
    expect(row.changes).toMatchObject({ status: { from: "pending", to: "declined" } });
  });
});

describe("reminders", () => {
  it("claims each due meeting once, even if swept twice", async () => {
    const [due] = await pgdb.insert(oneToOnes).values({ fromUserId: "a", toUserId: "b", proposedAt: new Date(Date.now() + 30 * 60_000), status: "accepted" }).returning();
    await pgdb.insert(oneToOnes).values({ fromUserId: "a", toUserId: "b", proposedAt: new Date(Date.now() + 5 * 3_600_000), status: "accepted" });
    await pgdb.insert(oneToOnes).values({ fromUserId: "b", toUserId: "a", proposedAt: new Date(Date.now() + 20 * 60_000), status: "pending" });

    const [first, second] = await Promise.all([svc.sweepReminders(), svc.sweepReminders()]);
    expect(first + second).toBe(1);
    expect((await pgdb.select().from(oneToOnes).where(eq(oneToOnes.id, due.id)))[0].reminderSent).toBe(true);
    expect(pushes.filter((p) => JSON.stringify(p).includes("one_to_one_reminder"))).toHaveLength(2);
  });
});

describe("member conclave list", () => {
  it("flags registration and strips other attendees' phone numbers", async () => {
    const [c] = await pgdb
      .insert(conclaves)
      .values({ name: "C", startDate: new Date(Date.now() + 86_400_000), participants: [{ id: 1, name: "Bala", phone: "+919000000002", _originalUid: "b" }] })
      .returning();
    await pgdb.insert(registrations).values({ conclaveId: c.id, userId: "x-legacy", email: "asha@x.com" });

    const [forA] = await listForMember("a");
    expect(forA.isRegistered).toBe(true); // matched by her email on a legacy registration
    expect(JSON.stringify(forA.participants)).not.toContain("9000000002");
    const [forB] = await listForMember("b");
    expect(forB.isRegistered).toBe(false);
  });

  it("keeps phones only for people the member shared a table with; returns my role and table", async () => {
    const participants = [
      { id: 1, name: "A", phone: "+911111111111", _originalUid: "a" },
      { id: 2, name: "B", phone: "+912222222222", _originalUid: "b" },
      { id: 3, name: "C", phone: "+913333333333", _originalUid: "c" },
    ];
    // a sits with b in round 1; c is never at a's table.
    const schedule = { rounds: [{ roundNumber: 1, tables: [{ tableNumber: 1, captainId: 1, memberIds: [2] }, { tableNumber: 2, captainId: 3, memberIds: [] }] }] };
    const [c] = await pgdb.insert(conclaves).values({ name: "S", startDate: new Date(), participants, schedule }).returning();
    await pgdb.insert(registrations).values({ conclaveId: c.id, userId: "a", role: "captain", tableNumber: 1 });

    const [forA] = await listForMember("a");
    const phones = (forA.participants as any[]).map((p) => p.phone ?? null);
    expect(phones).toEqual(["+911111111111", "+912222222222", null]);
    expect(forA).toMatchObject({ isRegistered: true, myRole: "captain", myTableNumber: 1 });
  });
});
