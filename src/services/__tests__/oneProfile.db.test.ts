import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Firebase logins: "live-*" uids exist, anything else has been deleted.
const fb = {
  getUser: vi.fn(async (uid: string) => {
    if (uid.startsWith("live-") || uid.startsWith("new-")) return { uid };
    throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
  }),
};
vi.mock("../../config/firebase.js", () => ({ auth: fb }));

const { pgdb, pool } = await import("../../db/client.js");
const { users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const usersSvc = await import("../user.service.js");

const asMember = <T>(uid: string, fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "mobile_app", actor: { uid, role: "member" }, changeCount: 0 }, fn);
const signUp = (uid: string, over: Record<string, unknown> = {}) =>
  asMember(uid, () =>
    usersSvc.updateMe(uid, { name: "Ganesh Anumukonda", phone: "+919951511311", email: "ganesh@manuen.com", businessName: "Manuen Infotech", businessCategory: "Software Development", location: "Guntur", ...over }),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await pgdb.execute(sql`TRUNCATE users CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("one profile per person", () => {
  it("a second sign-up with a number that has a live account is refused", async () => {
    await signUp("live-old");
    await expect(signUp("new-1", { email: "other@manuen.com" })).rejects.toMatchObject({ status: 409 });
    expect((await pgdb.select().from(users)).map((u) => u.uid)).toEqual(["live-old"]);
  });

  it("a second sign-up with a live account's email is refused", async () => {
    await signUp("live-old");
    await expect(signUp("new-1", { phone: "+919000000001" })).rejects.toMatchObject({ status: 409 });
  });

  it("a profile whose login is gone is removed, so the person can sign up again", async () => {
    await pgdb.insert(users).values({ uid: "gone-1", name: "Ganesh Anumukonda", phone: "+919951511311", email: "ganesh@manuen.com" });
    await signUp("new-1");
    expect((await pgdb.select().from(users)).map((u) => u.uid)).toEqual(["new-1"]);
  });

  it("existing members can keep editing; changing to a taken number is refused", async () => {
    await signUp("live-old");
    await signUp("live-old", { businessName: "Manuen Infotech OPC" }); // own number: fine
    await signUp("live-2", { phone: "+919000000002", email: "b@manuen.com" });
    await expect(asMember("live-2", () => usersSvc.updateMe("live-2", { phone: "9951511311" }))).rejects.toMatchObject({ status: 409 });
    const [u] = await pgdb.select().from(users).where(eq(users.uid, "live-2"));
    expect(u.phone).toBe("+919000000002");
  });

  it("if Firebase can't be reached, it refuses rather than allow a duplicate", async () => {
    await signUp("live-old");
    fb.getUser.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "app/network-error" }));
    await expect(signUp("new-1", { email: "x@manuen.com" })).rejects.toBeTruthy();
    expect((await pgdb.select().from(users)).length).toBe(1);
  });
});
