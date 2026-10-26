import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Firebase Auth is faked; the data layer is real Postgres.
const existingLogins = new Map<string, string>();
const fb = {
  getUserByEmail: vi.fn(async (email: string) => {
    const uid = existingLogins.get(email);
    if (!uid) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
    return { uid };
  }),
  createUser: vi.fn(async (u: any) => ({ uid: `fb-${u.email}` })),
};
vi.mock("../../config/firebase.js", () => ({ auth: fb }));

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, registrations, users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const svc = await import("../conclaveMembers.service.js");
const pay = await import("../payments.service.js");

const admin = { uid: "a1", role: "admin" };
const superadmin = { uid: "s1", role: "superadmin" };
const as = <T>(actor: { uid: string; role: string }, fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "admin_panel", actor, changeCount: 0 }, fn);
const regOf = async (cid: string, uid: string) =>
  (await pgdb.select().from(registrations).where(and(eq(registrations.conclaveId, cid), eq(registrations.userId, uid))))[0];

async function conclave(over: Partial<typeof conclaves.$inferInsert> = {}) {
  const [c] = await pgdb
    .insert(conclaves)
    .values({ name: "C", venueLocation: "Hall", startDate: new Date(Date.now() + 10 * 86_400_000), status: "registrationOpen", isRegistrationOpen: true, region: "Guntur", ...over })
    .returning();
  return c.id;
}

beforeEach(async () => {
  existingLogins.clear();
  fb.createUser.mockClear();
  await pgdb.execute(sql`TRUNCATE conclaves, users CASCADE`);
  await pgdb.insert(users).values([{ uid: "m1", name: "Asha", phone: "+919000000001", email: "asha@x.com" }]);
});
afterAll(async () => {
  await pool.end();
});

describe("permission switch", () => {
  it("admins are blocked until a superadmin allows it; only a superadmin can flip it", async () => {
    const id = await conclave();
    expect((await svc.getPermissions(id, "admin")).canAddMembers).toBe(false);
    expect((await svc.getPermissions(id, "superadmin")).canAddMembers).toBe(true);
    await expect(as(admin, () => svc.addMember(id, { userId: "m1" }, admin))).rejects.toThrow(/superadmin/);
    await expect(as(admin, () => svc.setPermissions(id, true, "admin"))).rejects.toThrow(/superadmin/);

    await as(superadmin, () => svc.setPermissions(id, true, "superadmin"));
    expect((await svc.getPermissions(id, "admin")).canAddMembers).toBe(true);
    const rows = await pgdb.select().from(auditLog).where(and(eq(auditLog.action, "conclave.set_member_permission"), eq(auditLog.entityId, id)));
    expect(rows).toHaveLength(1);
  });
});

describe("add", () => {
  it("registers an existing member found by phone, with their profile name", async () => {
    const id = await conclave();
    const out = await as(superadmin, () => svc.addMember(id, { phone: "9000000001" }, superadmin));
    expect(out.createdAccount).toBe(false);
    expect(out.defaultPassword).toBeUndefined();
    expect(out.registration).toMatchObject({ userId: "m1", name: "Asha", status: "confirmed", paymentStatus: "paid" });
    expect(fb.createUser).not.toHaveBeenCalled();
    await expect(as(superadmin, () => svc.addMember(id, { userId: "m1" }, superadmin))).rejects.toThrow(/already registered/);
  });

  it("creates a phone sign-in with a random temporary password (never the phone number)", async () => {
    const id = await conclave();
    const out = await as(superadmin, () => svc.addMember(id, { name: "Ravi", phone: "9888877777", category: "CA" }, superadmin));
    expect(out.createdAccount).toBe(true);
    expect(out.loginIdentifier).toBe("9888877777");
    expect(out.defaultPassword).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(out.defaultPassword).not.toContain("9888877777");
    expect(fb.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "919888877777@bni121.conclave" }));
    const [u] = await pgdb.select().from(users).where(eq(users.uid, out.registration.userId));
    expect(u).toMatchObject({ name: "Ravi", phone: "+919888877777", category: "CA", region: "Guntur", defaultPasswordAssigned: true });
  });

  it("reuses an existing Firebase login that has no profile yet", async () => {
    const id = await conclave();
    existingLogins.set("new@x.com", "fb-existing");
    const out = await as(superadmin, () => svc.addMember(id, { name: "New", email: "New@x.com" }, superadmin));
    expect(out.registration.userId).toBe("fb-existing");
    expect(out.createdAccount).toBe(false);
    expect(fb.createUser).not.toHaveBeenCalled();
  });

  it("refuses once the schedule is locked or the conclave is running", async () => {
    const locked = await conclave({ isScheduleLocked: true });
    await expect(as(superadmin, () => svc.addMember(locked, { userId: "m1" }, superadmin))).rejects.toThrow(/locked/);
    const running = await conclave({ status: "running" });
    await expect(as(superadmin, () => svc.addMember(running, { userId: "m1" }, superadmin))).rejects.toThrow(/running/);
  });

  it("respects the member limit for admins", async () => {
    const id = await conclave({ allowAdminAddMembers: true, memberLimit: 1 });
    await as(admin, () => svc.addMember(id, { userId: "m1" }, admin));
    await expect(as(admin, () => svc.addMember(id, { name: "B", phone: "9111111111" }, admin))).rejects.toThrow(/full/);
  });
});

describe("edit and remove", () => {
  it("edits details and payment, syncs the profile, and audits", async () => {
    const id = await conclave({ allowAdminAddMembers: true });
    await as(admin, () => svc.addMember(id, { userId: "m1", paymentStatus: "pending", paymentAmount: 500 }, admin));
    const after = await as(admin, () => svc.updateMember(id, "m1", { company: "Glassworks", paymentStatus: "paid", transactionId: "UTR1" }, "admin"));
    expect(after).toMatchObject({ company: "Glassworks", paymentStatus: "paid", amountPaid: 500 });
    expect(after.payment).toMatchObject({ status: "paid", transactionId: "UTR1", amount: 500 });
    const [u] = await pgdb.select().from(users).where(eq(users.uid, "m1"));
    expect(u.company).toBe("Glassworks");
  });

  it("role changes and removal stop once the schedule is locked", async () => {
    const id = await conclave({ allowAdminAddMembers: true });
    await as(admin, () => svc.addMember(id, { userId: "m1" }, admin));
    await pgdb.update(conclaves).set({ isScheduleLocked: true }).where(eq(conclaves.id, id));
    await expect(as(admin, () => svc.updateMember(id, "m1", { role: "captain" }, "admin"))).rejects.toThrow(/locked/);
    await expect(as(admin, () => svc.removeMember(id, "m1", "admin"))).rejects.toThrow(/locked/);
    // Plain detail fixes are still fine.
    await as(admin, () => svc.updateMember(id, "m1", { chapter: "Eagles" }, "admin"));
    expect((await regOf(id, "m1")).chapter).toBe("Eagles");
  });

  it("removes a member before the schedule is locked", async () => {
    const id = await conclave({ allowAdminAddMembers: true });
    await as(admin, () => svc.addMember(id, { userId: "m1" }, admin));
    await as(admin, () => svc.removeMember(id, "m1", "admin"));
    expect(await regOf(id, "m1")).toBeUndefined();
  });
});

describe("payments list", () => {
  it("falls back to the profile for names when the registration has no snapshot", async () => {
    const id = await conclave();
    await pgdb.insert(registrations).values({ conclaveId: id, userId: "m1", status: "confirmed", paymentStatus: "paid" });
    const out = await pay.getConclavePayments(id);
    expect(out.members[0]).toMatchObject({ name: "Asha", email: "asha@x.com", phone: "+919000000001" });
  });

  it("registrations for a free conclave show as free, not pending", async () => {
    const free = await conclave();
    const paid = await conclave({ registrationFee: 500 });
    await pgdb.insert(registrations).values([
      { conclaveId: free, userId: "m1", status: "pending" },
      { conclaveId: paid, userId: "m1", status: "pending" },
    ]);
    const f = await pay.getConclavePayments(free);
    expect(f.members[0].paymentStatus).toBe("free");
    expect(f.counts).toMatchObject({ free: 1, pending: 0, total: 1 });
    expect(f.registrationFee).toBe(0);
    expect((await pay.getConclavePayments(paid)).members[0].paymentStatus).toBe("pending");
  });
});

describe("member lists", () => {
  it("the directory leaves out admin accounts and falls back to the conclave's region", async () => {
    const { admins } = await import("../../db/schema.js");
    const usersSvc = await import("../user.service.js");
    await pgdb.delete(admins).where(eq(admins.uid, "adm"));
    await pgdb.insert(users).values({ uid: "adm", name: "" });
    await pgdb.insert(admins).values({ uid: "adm", email: "adm@x.com", name: "Adm", role: "admin" });
    const id = await conclave();
    await pgdb.insert(registrations).values({ conclaveId: id, userId: "m1", role: "captain", tableNumber: 3 });

    const list = await usersSvc.listAllMembersForAdmin();
    expect(list.map((m) => m.id)).toEqual(["m1"]);
    expect(list[0].region).toBe("Guntur");
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [r] = await usersSvc.listRegistrants(id);
    expect(r).toMatchObject({ uid: "m1", region: "Guntur", tableNumber: 3, role: "captain" });
    await pgdb.delete(admins).where(eq(admins.uid, "adm"));
  });
});
