import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Firebase Auth is the only thing faked; the data layer is real Postgres.
const fb = {
  createUser: vi.fn(async (u: any) => ({ uid: `fb-${u.email}` })),
  updateUser: vi.fn(async () => ({})),
  deleteUser: vi.fn(async () => {}),
};
vi.mock("../../config/firebase.js", () => ({ auth: fb }));

const { pgdb, pool } = await import("../../db/client.js");
const { admins, auditLog, conclaves, notifications, registrations, users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const adminsSvc = await import("../admins.service.js");
const usersSvc = await import("../user.service.js");
const inbox = await import("../notifications.service.js");

type Rec = import("../admins.service.js").AdminRecord;
const rec = (uid: string, role: Rec["role"]): Rec => ({ uid, role, email: `${uid}@bni.com`, name: uid, region: null, status: "Active" });
const SUPER = rec("super", "superadmin");
const ADMIN = rec("adm", "admin");
const COORD = rec("coord", "coordinator");

async function as<T>(actor: Rec | { uid: string; role: string }, fn: () => Promise<T>) {
  const requestId = `t-${Math.random().toString(36).slice(2)}`;
  const result = await runWithContext({ requestId, source: "admin_panel", actor: { uid: actor.uid, role: actor.role }, changeCount: 0 }, fn);
  return { result, requestId };
}
const auditFor = (requestId: string) => pgdb.select().from(auditLog).where(eq(auditLog.requestId, requestId)).orderBy(auditLog.id);

beforeEach(async () => {
  vi.clearAllMocks();
  await pgdb.execute(sql`TRUNCATE admins, users, conclaves CASCADE`);
  await pgdb.insert(admins).values([
    { uid: "super", email: "super@bni.com", role: "superadmin" },
    { uid: "adm", email: "adm@bni.com", role: "admin" },
    { uid: "coord", email: "coord@bni.com", role: "coordinator", region: "Guntur Region" },
  ]);
});
afterAll(async () => {
  await pool.end();
});

describe("admin permission matrix", () => {
  it("superadmin can create any role; admin only coordinators; coordinator nobody", async () => {
    const make = (actor: Rec, role: string, email: string) =>
      as(actor, () => adminsSvc.createAdmin(actor, { email, password: "longenough", name: "N", role }));

    await expect(make(SUPER, "admin", "a1@x.com")).resolves.toBeTruthy();
    await expect(make(ADMIN, "coordinator", "c1@x.com")).resolves.toBeTruthy();
    await expect(make(ADMIN, "admin", "a2@x.com")).rejects.toMatchObject({ status: 403 });
    await expect(make(ADMIN, "superadmin", "s2@x.com")).rejects.toMatchObject({ status: 403 });
    await expect(make(COORD, "coordinator", "c2@x.com")).rejects.toMatchObject({ status: 403 });
    // Refused attempts never touched Firebase.
    expect(fb.createUser).toHaveBeenCalledTimes(2);
  });

  it("validates input before creating a login", async () => {
    await expect(as(SUPER, () => adminsSvc.createAdmin(SUPER, { email: "bad", password: "longenough", name: "N" }))).rejects.toMatchObject({ status: 400 });
    await expect(as(SUPER, () => adminsSvc.createAdmin(SUPER, { email: "a@x.com", password: "short", name: "N" }))).rejects.toMatchObject({ status: 400 });
    await expect(as(SUPER, () => adminsSvc.createAdmin(SUPER, { email: "a@x.com", password: "longenough", name: "N", role: "god" }))).rejects.toMatchObject({ status: 400 });
    expect(fb.createUser).not.toHaveBeenCalled();
  });

  it("an admin can't reset a superadmin's password or promote anyone to admin", async () => {
    await expect(as(ADMIN, () => adminsSvc.resetAdminPassword(ADMIN, "super", "newpassword1"))).rejects.toMatchObject({ status: 403 });
    await expect(as(ADMIN, () => adminsSvc.updateAdmin(ADMIN, "coord", { role: "admin" }))).rejects.toMatchObject({ status: 403 });
    expect(fb.updateUser).not.toHaveBeenCalled();
  });

  it("nobody can delete or demote themselves", async () => {
    await expect(as(SUPER, () => adminsSvc.deleteAdmin(SUPER, "super"))).rejects.toMatchObject({ status: 400 });
    await expect(as(SUPER, () => adminsSvc.updateAdmin(SUPER, "super", { role: "admin" }))).rejects.toMatchObject({ status: 400 });
  });

  it("audits changes; a password reset records who/whom but never the password", async () => {
    const { requestId: up } = await as(SUPER, () => adminsSvc.updateAdmin(SUPER, "coord", { region: "Vijayawada Region" }));
    expect((await auditFor(up))[0]).toMatchObject({
      action: "admin.update",
      actorUid: "super",
      changes: { region: { from: "Guntur Region", to: "Vijayawada Region" } },
    });
    const { requestId: rp } = await as(SUPER, () => adminsSvc.resetAdminPassword(SUPER, "coord", "s3cret-pass"));
    const [row] = await auditFor(rp);
    expect(row.action).toBe("admin.reset_password");
    expect(JSON.stringify(row)).not.toContain("s3cret-pass");
  });

  it("removes the Firebase login again if saving the admin row fails", async () => {
    await as(SUPER, () => adminsSvc.createAdmin(SUPER, { email: "dup@x.com", password: "longenough", name: "N" }));
    fb.createUser.mockResolvedValueOnce({ uid: "other-uid" });
    await expect(as(SUPER, () => adminsSvc.createAdmin(SUPER, { email: "DUP@x.com", password: "longenough", name: "N" }))).rejects.toMatchObject({ status: 409 });
    expect(fb.deleteUser).toHaveBeenCalledWith("other-uid");
  });

  it("only superadmins see superadmins in the list", async () => {
    expect((await adminsSvc.listAdmins(ADMIN)).map((a) => a.uid).sort()).toEqual(["adm", "coord"]);
    expect((await adminsSvc.listAdmins(SUPER)).map((a) => a.uid).sort()).toEqual(["adm", "coord", "super"]);
  });
});

describe("users", () => {
  beforeEach(async () => {
    await pgdb.insert(users).values([
      { uid: "u1", name: "Asha", email: "asha@x.com", phone: "+919515409973", identifier: "919515409973@bni121.conclave", company: "Glassworks", category: "Glass" },
      { uid: "u2", name: "", email: "half@x.com" },
    ]);
  });

  it("the directory never exposes contact details and skips nameless rows", async () => {
    const dir = await usersSvc.listMemberDirectory();
    expect(dir).toHaveLength(1);
    expect(dir[0]).toMatchObject({ uid: "u1", name: "Asha", businessName: "Glassworks", businessCategory: "Glass" });
    expect(JSON.stringify(dir)).not.toMatch(/asha@x\.com|9515409973|bni121/);
  });

  it("resolves a sign-in address from phone or email, and reveals nothing else", async () => {
    expect(await usersSvc.resolveSignInAddress("95154 09973")).toBe("919515409973@bni121.conclave");
    expect(await usersSvc.resolveSignInAddress("ASHA@x.com")).toBe("919515409973@bni121.conclave");
    // Unknown inputs get the same shape of answer, so membership can't be probed.
    expect(await usersSvc.resolveSignInAddress("9000000000")).toBe("919000000000@bni121.conclave");
    expect(await usersSvc.resolveSignInAddress("nobody@x.com")).toBe("nobody@x.com");
  });

  it("an admin can't change their own region through /me", async () => {
    await as({ uid: "coord", role: "coordinator" }, () => usersSvc.updateMe("coord", { name: "C", region: "Elsewhere" }));
    const [row] = await pgdb.select().from(admins).where(eq(admins.uid, "coord"));
    expect(row.region).toBe("Guntur Region");
    expect(row.name).toBe("C");
  });

  it("a member update normalises the phone, keeps identifier in step, and is audited", async () => {
    const { requestId } = await as({ uid: "u1", role: "member" }, () => usersSvc.updateMe("u1", { phone: "9000000001", businessName: "New Co" }));
    const [u] = await pgdb.select().from(users).where(eq(users.uid, "u1"));
    expect(u).toMatchObject({ phone: "+919000000001", identifier: "919000000001@bni121.conclave", company: "New Co" });
    expect((await auditFor(requestId))[0].changes).toMatchObject({
      phone: { from: "+919515409973", to: "+919000000001" },
      company: { from: "Glassworks", to: "New Co" },
    });
  });

  it("admin role assignment on a member is limited to member/captain", async () => {
    await expect(as(ADMIN, () => usersSvc.setUserRole("u1", "superadmin"))).rejects.toMatchObject({ status: 400 });
    await as(ADMIN, () => usersSvc.setUserRole("u1", "captain"));
    expect((await pgdb.select().from(users).where(eq(users.uid, "u1")))[0].role).toBe("captain");
  });

  it("/me: admin roles come only from the admins table; captain only while running", async () => {
    expect((await usersSvc.getMe({ uid: "coord" })).role).toBe("coordinator");
    await pgdb.update(users).set({ role: "superadmin" }).where(eq(users.uid, "u1")); // legacy junk
    expect((await usersSvc.getMe({ uid: "u1" })).role).toBe("member");

    const [c] = await pgdb.insert(conclaves).values({ name: "Live", status: "running" }).returning();
    await pgdb.insert(registrations).values({ conclaveId: c.id, userId: "u1", role: "captain" });
    expect(await usersSvc.getMe({ uid: "u1" })).toMatchObject({ role: "captain", isCaptain: true });
  });

  it("/me: email fallback only for a verified email", async () => {
    expect((await usersSvc.getMe({ uid: "new-login", email: "asha@x.com", emailVerified: false })).name).toBe("Member");
    expect((await usersSvc.getMe({ uid: "new-login", email: "asha@x.com", emailVerified: true })).name).toBe("Asha");
  });

  it("deleting an account removes profile + inbox and keeps no personal data in the audit", async () => {
    await inbox.record("u1", { title: "Hi", body: "B", type: "x" });
    const { requestId } = await as({ uid: "u1", role: "member" }, () => usersSvc.deleteOwnAccount("u1"));
    expect(await pgdb.select().from(users).where(eq(users.uid, "u1"))).toHaveLength(0);
    expect(await pgdb.select().from(notifications).where(eq(notifications.userId, "u1"))).toHaveLength(0);
    expect(fb.deleteUser).toHaveBeenCalledWith("u1");
    const [row] = await auditFor(requestId);
    expect(row.action).toBe("user.delete_self");
    expect(JSON.stringify(row)).not.toMatch(/Asha|asha@x\.com|9515409973/);
  });
});

describe("notification inbox", () => {
  it("lists newest first with an unread count, marks read, and ignores unknown users", async () => {
    await pgdb.insert(users).values({ uid: "u9", name: "N" });
    await inbox.record("u9", { title: "1", body: "a", type: "t" });
    await inbox.record("u9", { title: "2", body: "b", type: "t", data: { id: "x" } });
    await inbox.record("ghost", { title: "x", body: "y", type: "t" }); // no profile → silently skipped
    const list = await inbox.listForUser("u9");
    expect(list.unreadCount).toBe(2);
    expect(list.notifications.map((n) => n.title)).toEqual(["2", "1"]);
    expect(await inbox.markAllRead("u9")).toBe(2);
    expect((await inbox.listForUser("u9")).unreadCount).toBe(0);
  });
});
