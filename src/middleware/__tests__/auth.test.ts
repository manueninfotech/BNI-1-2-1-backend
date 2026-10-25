import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * Auth regression tests (bypasses fixed 2026-10-24): an unverifiable token used
 * to be accepted as the uid itself, or as the superadmin if it contained
 * "admin"; any email containing "admin" was an admin; a lookup error granted
 * access. The allowlist is real Postgres rows; only Firebase token verification
 * is faked.
 */

const verifyIdToken = vi.fn();
vi.mock("../../config/firebase.js", () => ({
  auth: { verifyIdToken: (t: string) => verifyIdToken(t) },
}));
vi.mock("../../config/env.js", async (orig) => {
  const real: any = await orig();
  return { ...real, env: { ...real.env, allowInsecureAdmin: false } };
});

let allowlistDown = false;
vi.mock("../../services/admins.service.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    findActiveAdmin: (...a: unknown[]) =>
      allowlistDown ? Promise.reject(new Error("db down")) : real.findActiveAdmin(...a),
  };
});

const { requireUser, requireAdmin, requireSuperadmin, requireRole, clearAdminCache } = await import("../auth.js");
const { pgdb, pool } = await import("../../db/client.js");
const { admins } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");

const reqWith = (token?: string): any => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
async function run(mw: any, req: any) {
  const next = vi.fn();
  try {
    await runWithContext({ requestId: "auth-test", source: "unknown", actor: { uid: null, role: "anonymous" }, changeCount: 0 }, () =>
      mw(req, {}, next),
    );
    return { ok: next.mock.calls.length === 1, status: 200, req };
  } catch (e: any) {
    return { ok: false, status: e.status as number, req };
  }
}
const tokenFor = (uid: string, email?: string, email_verified = true) =>
  verifyIdToken.mockImplementation(async (t: string) => {
    if (t === "good-token") return { uid, email, email_verified };
    throw new Error("invalid token");
  });

beforeEach(async () => {
  verifyIdToken.mockReset();
  verifyIdToken.mockRejectedValue(new Error("invalid token"));
  allowlistDown = false;
  clearAdminCache();
  await pgdb.execute(sql`TRUNCATE admins`);
  await pgdb.insert(admins).values([
    { uid: "admin-uid", email: "boss@bni.com", role: "admin" },
    { uid: "super-uid", email: "root@bni.com", role: "superadmin" },
    { uid: "coord-uid", email: "coord@bni.com", role: "coordinator" },
    { uid: "gone-uid", email: "gone@bni.com", role: "admin", status: "Inactive" },
  ]);
});
afterAll(async () => {
  await pool.end();
});

describe("requireUser", () => {
  it("rejects a missing token", async () => {
    expect((await run(requireUser, reqWith())).status).toBe(401);
  });

  it.each(["someone@example.com", "usr_123", "admin_1", "superadmin", "admin"])(
    "rejects an unverifiable token %j instead of trusting it as the uid",
    async (token) => {
      const r = await run(requireUser, reqWith(token));
      expect(r.ok).toBe(false);
      expect(r.status).toBe(401);
      expect(r.req.uid).toBeUndefined();
    },
  );

  it("accepts a verified token and takes the uid from it", async () => {
    tokenFor("member-uid", "m@x.com");
    const r = await run(requireUser, reqWith("good-token"));
    expect(r.ok).toBe(true);
    expect(r.req.uid).toBe("member-uid");
    expect(r.req.emailVerified).toBe(true);
  });
});

describe("requireAdmin", () => {
  it.each(["admin", "superadmin", "admin_1", "superadmin@bni.com", "boss@bni.com"])(
    "rejects the fake admin token %j",
    async (token) => {
      const r = await run(requireAdmin, reqWith(token));
      expect(r.ok).toBe(false);
      expect(r.status).toBe(401);
    },
  );

  it("admits a verified uid on the allowlist and attaches its record", async () => {
    tokenFor("admin-uid", "boss@bni.com");
    const r = await run(requireAdmin, reqWith("good-token"));
    expect(r.ok).toBe(true);
    expect(r.req.admin).toMatchObject({ uid: "admin-uid", role: "admin" });
  });

  it("refuses a verified user who is not on the allowlist, whatever their email says", async () => {
    tokenFor("rando", "notanadmin+superadmin@gmail.com");
    expect((await run(requireAdmin, reqWith("good-token"))).status).toBe(403);
  });

  it("refuses an Inactive admin", async () => {
    tokenFor("gone-uid", "gone@bni.com");
    expect((await run(requireAdmin, reqWith("good-token"))).status).toBe(403);
  });

  it("matches by email only when verified, and re-keys the row instead of duplicating it", async () => {
    tokenFor("new-uid", "boss@bni.com", false);
    expect((await run(requireAdmin, reqWith("good-token"))).status).toBe(403);

    tokenFor("new-uid", "boss@bni.com", true);
    expect((await run(requireAdmin, reqWith("good-token"))).ok).toBe(true);
    const rows = await pgdb.select().from(admins).where(sql`lower(${admins.email}) = 'boss@bni.com'`);
    expect(rows.map((r) => r.uid)).toEqual(["new-uid"]);
  });

  it("denies (503) when the allowlist lookup fails, instead of granting access", async () => {
    tokenFor("someone-new", "x@y.com");
    allowlistDown = true;
    const r = await run(requireAdmin, reqWith("good-token"));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });
});

describe("requireSuperadmin / requireRole", () => {
  const withAdmin = async (uid: string) => {
    tokenFor(uid);
    const r = await run(requireAdmin, reqWith("good-token"));
    return r.req;
  };

  it("allows a stored superadmin only", async () => {
    expect((await run(requireSuperadmin, await withAdmin("super-uid"))).ok).toBe(true);
    expect((await run(requireSuperadmin, await withAdmin("admin-uid"))).status).toBe(403);
  });

  it("keeps coordinators out of admin-and-up areas", async () => {
    const gate = requireRole("admin", "superadmin");
    expect((await run(gate, await withAdmin("admin-uid"))).ok).toBe(true);
    expect((await run(gate, await withAdmin("coord-uid"))).status).toBe(403);
  });

  it("does not trust a role that is not stored", async () => {
    await pgdb.update(admins).set({ email: "superadmin.fan@bni.com" }).where(eq(admins.uid, "admin-uid"));
    clearAdminCache();
    expect((await run(requireSuperadmin, await withAdmin("admin-uid"))).status).toBe(403);
  });
});

describe("canManage (admin account permission matrix)", () => {
  it("superadmin → anyone; admin → coordinators only; coordinator → nobody", async () => {
    const { canManage } = await import("../../services/admins.service.js");
    expect(canManage("superadmin", "superadmin")).toBe(true);
    expect(canManage("superadmin", "admin")).toBe(true);
    expect(canManage("admin", "coordinator")).toBe(true);
    expect(canManage("admin", "admin")).toBe(false);
    expect(canManage("admin", "superadmin")).toBe(false);
    expect(canManage("coordinator", "coordinator")).toBe(false);
  });
});
