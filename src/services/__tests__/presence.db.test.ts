import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("../../config/firebase.js", () => ({ auth: {} }));

const { pgdb, pool } = await import("../../db/client.js");
const { users } = await import("../../db/schema.js");
const svc = await import("../user.service.js");

const ago = (ms: number) => new Date(Date.now() - ms);

beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE conclaves, users CASCADE`);
  await pgdb.insert(users).values({ uid: "m1", name: "Asha", lastLoginAt: ago(30 * 86_400_000) });
});
afterAll(async () => {
  await pool.end();
});

describe("presence", () => {
  it("open app = online now; closing it = offline but still present today", async () => {
    await svc.setPresence("m1", "foreground");
    let [u] = await pgdb.select().from(users).where(eq(users.uid, "m1"));
    expect(svc.isOnlineNow(u, new Date())).toBe(true);
    expect(svc.isActiveUser(u, 5, new Date())).toBe(true);

    await svc.setPresence("m1", "background");
    [u] = await pgdb.select().from(users).where(eq(users.uid, "m1"));
    expect(svc.isOnlineNow(u, new Date())).toBe(false);
    // Phone in the pocket: still counts as at the venue for seating.
    expect(svc.isActiveUser(u, 5, new Date())).toBe(true);
  });

  it("an app that stops checking in goes offline after 5 minutes, and stops counting as present after the window", () => {
    const silent = { isActive: true, lastActiveAt: ago(6 * 60_000), lastLoginAt: null } as any;
    expect(svc.isOnlineNow(silent, new Date())).toBe(false);
    expect(svc.isActiveUser({ lastLoginAt: ago(30 * 86_400_000), lastActiveAt: ago(6 * 3_600_000) } as any, 5, new Date())).toBe(false);
  });

  it("rejects unknown states", async () => {
    await expect(svc.setPresence("m1", "sleeping")).rejects.toThrow(/foreground/);
  });
});
