import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("../../config/firebase.js", () => ({
  auth: { verifyIdToken: vi.fn(), getUser: vi.fn(), getUserByEmail: vi.fn(), createUser: vi.fn() },
  messaging: { send: vi.fn(), sendEachForMulticast: vi.fn() },
}));

const { pgdb, pool } = await import("../../db/client.js");
const { conclaves } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const storage = await import("../storage.service.js");
const svc = await import("../conclave.service.js");
const { liveState } = await import("../live.service.js");

const mem = storage.memoryProvider();
storage.setStorageProvider(mem);
const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "admin_panel", actor: { uid: "adm", role: "admin" }, changeCount: 0 }, fn);

// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let id = "";

beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE conclaves CASCADE`);
  mem.files.clear();
  const [c] = await pgdb.insert(conclaves).values({ name: "C", startDate: new Date(Date.now() + 86_400_000) }).returning();
  id = c.id;
});
afterAll(async () => {
  storage.setStorageProvider(null);
  await pool.end();
});

describe("cover image and flyers", () => {
  it("sets, replaces and clears the cover, deleting the old file", async () => {
    const first = await asAdmin(() => svc.setCoverImage(id, { dataUrl: PNG, name: "Cover" }));
    expect(first).toMatchObject({ name: "Cover" });
    expect(first!.url).toMatch(/^\/api\/files\/conclave-covers\//);
    expect(mem.files.size).toBe(1);
    await asAdmin(() => svc.setCoverImage(id, { dataUrl: PNG }));
    expect(mem.files.size).toBe(1); // the first file is gone
    await asAdmin(() => svc.setCoverImage(id, null));
    expect(mem.files.size).toBe(0);
    const [row] = await pgdb.select().from(conclaves).where(eq(conclaves.id, id));
    expect(row.coverImage).toBeNull();
  });

  it("adds, reorders and removes flyers; clients never see storage paths", async () => {
    const a = await asAdmin(() => svc.addFlyer(id, { dataUrl: PNG, name: "A" }));
    const b = await asAdmin(() => svc.addFlyer(id, { dataUrl: PNG, name: "B" }));
    expect(b.map((f) => f!.name)).toEqual(["A", "B"]);
    const swapped = await asAdmin(() => svc.reorderFlyers(id, [b[1]!.id, a[0]!.id]));
    expect(swapped.map((f) => f!.name)).toEqual(["B", "A"]);
    const left = await asAdmin(() => svc.removeFlyer(id, a[0]!.id));
    expect(left.map((f) => f!.name)).toEqual(["B"]);
    expect(mem.files.size).toBe(1);
    const live = await liveState(id);
    expect(live!.flyers).toEqual([{ id: b[1]!.id, url: b[1]!.url, name: "B" }]);
    expect(Object.keys(live!.flyers[0]!)).toEqual(["id", "url", "name"]);
  });

  it("rejects non-images, bad orders and too many flyers, without orphaning files", async () => {
    await expect(asAdmin(() => svc.addFlyer(id, { dataUrl: "data:application/pdf;base64,JVBERi0=" }))).rejects.toMatchObject({ status: 400 });
    await asAdmin(() => svc.addFlyer(id, { dataUrl: PNG }));
    await expect(asAdmin(() => svc.reorderFlyers(id, ["nope"]))).rejects.toMatchObject({ status: 400 });
    for (let i = 1; i < svc.MAX_FLYERS; i++) await asAdmin(() => svc.addFlyer(id, { dataUrl: PNG }));
    await expect(asAdmin(() => svc.addFlyer(id, { dataUrl: PNG }))).rejects.toMatchObject({ status: 400 });
    expect(mem.files.size).toBe(svc.MAX_FLYERS);
  });
});
