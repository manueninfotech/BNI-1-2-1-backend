import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { pgdb, pool } from "../../db/client.js";
import { auditLog, conclaves, regions, users } from "../../db/schema.js";
import { runWithContext } from "../../observability/context.js";
import * as categories from "../categories.service.js";
import * as settingsSvc from "../settings.service.js";
import * as regionsSvc from "../regions.service.js";

/** Run as a known admin inside a fresh request context; returns its request id. */
async function asAdmin<T>(fn: () => Promise<T>): Promise<{ result: T; requestId: string }> {
  const requestId = `t-${Math.random().toString(36).slice(2)}`;
  const result = await runWithContext(
    { requestId, source: "admin_panel", actor: { uid: "admin-1", role: "admin", email: "a@bni.com" }, changeCount: 0 },
    fn,
  );
  return { result, requestId };
}
const auditFor = (requestId: string) =>
  pgdb.select().from(auditLog).where(eq(auditLog.requestId, requestId)).orderBy(auditLog.id);

beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE settings, regions, users, conclaves CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("categories", () => {
  it("normalises: trims, de-dupes case-insensitively, sorts, pins Other last", async () => {
    const { result } = await asAdmin(() => categories.setCategories([" Tax ", "other", "audit", "TAX", ""]));
    expect(result).toEqual(["audit", "Tax", "other"]);
    expect(await categories.listCategories()).toEqual(["audit", "Tax", "other"]);
  });

  it("rejects an empty list and duplicate adds", async () => {
    await expect(asAdmin(() => categories.setCategories([]))).rejects.toMatchObject({ status: 400 });
    await asAdmin(() => categories.setCategories(["Glass"]));
    await expect(asAdmin(() => categories.addCategory("glass"))).rejects.toMatchObject({ status: 409 });
  });

  it("audits each edit with the before/after list", async () => {
    await asAdmin(() => categories.setCategories(["Glass"]));
    const { requestId } = await asAdmin(() => categories.addCategory("Wood"));
    const [row] = await auditFor(requestId);
    expect(row).toMatchObject({
      kind: "change",
      action: "settings.update",
      entityId: "businessCategories",
      actorUid: "admin-1",
      changes: { categories: { from: ["Glass"], to: ["Glass", "Wood"] } },
    });
  });
});

describe("settings", () => {
  it("bio (1 min) and referral (30 s) times are fixed", async () => {
    expect(await settingsSvc.getRoundTiming()).toEqual({ bioSeconds: 60, referralSeconds: 30, bufferSeconds: 120 });
    await expect(asAdmin(() => settingsSvc.setRoundTiming({ bioSeconds: 90 }))).rejects.toThrow(/fixed/);
    expect(await settingsSvc.getRoundTiming()).toEqual({ bioSeconds: 60, referralSeconds: 30, bufferSeconds: 120 });
  });

  it("fills notification templates", async () => {
    await asAdmin(() => settingsSvc.setNotificationTemplates({ roundStarted: { title: "R{round}", body: "Go" } }));
    expect(await settingsSvc.resolveNotification("roundStarted", { round: 3 })).toEqual({ title: "R3", body: "Go" });
  });
});

describe("regions", () => {
  it("seeds the defaults on first list, audited", async () => {
    const { result, requestId } = await asAdmin(() => regionsSvc.listRegions());
    expect(result.map((r) => r.name)).toEqual(["Guntur Region", "Singapore Metro", "Vijayawada Region", "Visakhapatnam Region"]);
    expect((await auditFor(requestId)).filter((r) => r.action === "region.create")).toHaveLength(4);
  });

  it("counts conclaves and members per region", async () => {
    await asAdmin(() => regionsSvc.createRegion({ name: "Guntur Region" }));
    await pgdb.insert(users).values([
      { uid: "u1", region: "Guntur Region" },
      { uid: "u2", location: "Guntur Region" },
      { uid: "u3", region: "Elsewhere" },
    ]);
    await pgdb.insert(conclaves).values({ name: "C1", region: "Guntur Region" });
    const [g] = await regionsSvc.listRegions();
    expect(g).toMatchObject({ name: "Guntur Region", conclavesCount: 1, membersCount: 2 });
  });

  it("rejects duplicate names (case-insensitive) and bad input", async () => {
    await asAdmin(() => regionsSvc.createRegion({ name: "Guntur Region" }));
    await expect(asAdmin(() => regionsSvc.createRegion({ name: "guntur region" }))).rejects.toMatchObject({ status: 409 });
    await expect(asAdmin(() => regionsSvc.createRegion({ name: "  " }))).rejects.toMatchObject({ status: 400 });
    await expect(asAdmin(() => regionsSvc.createRegion({ name: "X", status: "Maybe" }))).rejects.toMatchObject({ status: 400 });
  });

  it("audits update and delete with before/after", async () => {
    const { result: created } = await asAdmin(() => regionsSvc.createRegion({ name: "Old" }));
    const { requestId: up } = await asAdmin(() => regionsSvc.updateRegion(created.id, { name: "New", status: "Inactive" }));
    const [u] = await auditFor(up);
    expect(u.changes).toEqual({ name: { from: "Old", to: "New" }, status: { from: "Active", to: "Inactive" } });

    const { requestId: del } = await asAdmin(() => regionsSvc.deleteRegion(created.id));
    const [d] = await auditFor(del);
    expect(d).toMatchObject({ action: "region.delete", entityId: created.id, metadata: { op: "delete" } });
    expect(await pgdb.select().from(regions).where(eq(regions.id, created.id))).toHaveLength(0);
    await expect(asAdmin(() => regionsSvc.deleteRegion(created.id))).rejects.toMatchObject({ status: 404 });
  });

  it("does not audit a failed change", async () => {
    const before = await pgdb.select({ n: sql<number>`count(*)::int` }).from(auditLog)
      .where(and(eq(auditLog.action, "region.update"), eq(auditLog.entityId, "missing")));
    await expect(asAdmin(() => regionsSvc.updateRegion("missing", { name: "X" }))).rejects.toMatchObject({ status: 404 });
    const after = await pgdb.select({ n: sql<number>`count(*)::int` }).from(auditLog)
      .where(and(eq(auditLog.action, "region.update"), eq(auditLog.entityId, "missing")));
    expect(after[0].n).toBe(before[0].n);
  });
});
