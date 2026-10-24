import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the auth bypasses fixed on 2026-10-24: an unverifiable
 * token used to be accepted as the uid itself (members) or as the superadmin
 * (any token containing "admin"), and an admin lookup error granted access.
 */

// --- Firebase mocks ---------------------------------------------------------
const verifyIdToken = vi.fn();
const adminDocs = new Map<string, Record<string, unknown>>();
let firestoreDown = false;

vi.mock("../../config/firebase.js", () => {
  const doc = (id: string) => ({
    get: async () => {
      if (firestoreDown) throw new Error("UNAVAILABLE");
      return { exists: adminDocs.has(id), data: () => adminDocs.get(id) };
    },
    set: async () => {},
  });
  const where = (_f: string, _op: string, email: string) => ({
    limit: () => ({
      get: async () => {
        if (firestoreDown) throw new Error("UNAVAILABLE");
        const hits = [...adminDocs.values()].filter((d) => d.email === email);
        return { empty: hits.length === 0, docs: hits.map((d) => ({ data: () => d })) };
      },
    }),
  });
  return {
    auth: { verifyIdToken: (t: string) => verifyIdToken(t) },
    db: { collection: () => ({ doc, where }) },
    collections: { admins: "admins" },
  };
});

vi.mock("../../config/env.js", () => ({ env: { allowInsecureAdmin: false } }));

const { requireUser, requireAdmin, requireSuperadmin } = await import("../auth.js");

// --- helpers ----------------------------------------------------------------
const reqWith = (token?: string): any => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
async function run(mw: any, req: any) {
  const next = vi.fn();
  try {
    await mw(req, {}, next);
    return { ok: next.mock.calls.length === 1, status: 200, req };
  } catch (e: any) {
    return { ok: false, status: e.status as number, req };
  }
}
const valid = (uid: string, email?: string, email_verified = true) =>
  verifyIdToken.mockImplementation(async (t: string) => {
    if (t === "good-token") return { uid, email, email_verified };
    throw new Error("invalid token");
  });

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockRejectedValue(new Error("invalid token"));
  adminDocs.clear();
  firestoreDown = false;
  adminDocs.set("admin-uid", { email: "boss@bni.com", role: "admin" });
  adminDocs.set("super-uid", { email: "root@bni.com", role: "superadmin" });
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
    valid("member-uid", "m@x.com");
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

  it("admits a verified uid on the allowlist", async () => {
    valid("admin-uid", "boss@bni.com");
    expect((await run(requireAdmin, reqWith("good-token"))).ok).toBe(true);
  });

  it("refuses a verified user who is not on the allowlist, whatever their email says", async () => {
    valid("rando", "notanadmin+superadmin@gmail.com");
    const r = await run(requireAdmin, reqWith("good-token"));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("matches by email only when Firebase verified that email", async () => {
    valid("new-uid", "boss@bni.com", false);
    expect((await run(requireAdmin, reqWith("good-token"))).status).toBe(403);
    valid("new-uid-2", "boss@bni.com", true);
    expect((await run(requireAdmin, reqWith("good-token"))).ok).toBe(true);
  });

  it("denies (503) when the allowlist lookup fails, instead of granting access", async () => {
    valid("someone-new", "x@y.com");
    firestoreDown = true;
    const r = await run(requireAdmin, reqWith("good-token"));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });
});

describe("requireSuperadmin", () => {
  it("allows a stored superadmin", async () => {
    expect((await run(requireSuperadmin, { uid: "super-uid", email: "root@bni.com" })).ok).toBe(true);
  });

  it("refuses a regular admin even if their email contains 'superadmin'", async () => {
    adminDocs.set("plain-uid", { email: "superadmin.fan@bni.com", role: "admin" });
    const r = await run(requireSuperadmin, { uid: "plain-uid", email: "superadmin.fan@bni.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});
