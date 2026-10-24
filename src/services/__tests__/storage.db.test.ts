import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";

vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  messaging: new Proxy({}, { get: () => async () => "ok" }),
  auth: {},
}));

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const storage = await import("../storage.service.js");
const { setAgenda } = await import("../conclave.service.js");

const mem = storage.memoryProvider();
storage.setStorageProvider(mem);
const as = <T>(fn: () => Promise<T>) =>
  runWithContext({ requestId: `t-${Math.random().toString(36).slice(2)}`, source: "admin_panel", actor: { uid: "adm", role: "admin" }, changeCount: 0 }, fn);
const pdf = (text = "%PDF-1.4 hello") => `data:application/pdf;base64,${Buffer.from(text).toString("base64")}`;

let id = "";
beforeEach(async () => {
  mem.files.clear();
  await pgdb.execute(sql`TRUNCATE conclaves CASCADE`);
  const [c] = await pgdb.insert(conclaves).values({ name: "C", startDate: new Date(Date.now() + 86_400_000) }).returning();
  id = c.id;
});
afterAll(async () => {
  storage.setStorageProvider(null);
  await pool.end();
});

describe("uploads", () => {
  it("stores under an unguessable path and links through our API", async () => {
    const f = await storage.uploadFile("agendas", "Day Plan (final).pdf", "application/pdf", Buffer.from("x"));
    expect(f.path).toMatch(/^agendas\/[0-9a-f-]{36}\/Day_Plan__final_\.pdf$/);
    expect(f.url).toBe(`/api/files/${f.path}`);
    expect(mem.files.has(f.path)).toBe(true);
  });

  it("refuses wrong types, empty and oversized files", async () => {
    await expect(storage.uploadFile("agendas", "x.exe", "application/x-msdownload", Buffer.from("x"))).rejects.toMatchObject({ status: 400 });
    await expect(storage.uploadFile("agendas", "x.pdf", "application/pdf", Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
    await expect(storage.uploadFile("agendas", "x.pdf", "application/pdf", Buffer.alloc(storage.MAX_BYTES + 1))).rejects.toMatchObject({ status: 400 });
  });

  it("signs links only for well-formed stored paths", async () => {
    const f = await storage.uploadFile("agendas", "a.pdf", "application/pdf", Buffer.from("x"));
    expect(await storage.signedLink(f.path)).toBe(`memory://${f.path}`);
    expect(await storage.signedLink("agendas/../secrets")).toBeNull();
    expect(await storage.signedLink("agendas/00000000-0000-0000-0000-000000000000/missing.pdf")).toBeNull();
  });
});

describe("agenda", () => {
  it("set, replace and clear are audited; the replaced file is deleted", async () => {
    const first = await as(() => setAgenda(id, { dataUrl: pdf(), name: "agenda.pdf" }));
    const second = await as(() => setAgenda(id, { dataUrl: pdf("v2"), name: "agenda-v2.pdf" }));
    expect(mem.files.has(String(first!.storagePath))).toBe(false);
    expect(mem.files.has(String(second!.storagePath))).toBe(true);

    await as(() => setAgenda(id, null));
    expect(mem.files.size).toBe(0);
    const [row] = await pgdb.select().from(conclaves).where(eq(conclaves.id, id));
    expect(row.agendaDocument).toBeNull();

    const actions = (await pgdb.select().from(auditLog).where(and(eq(auditLog.conclaveId, id), eq(auditLog.entityType, "conclave")))).map((a) => a.action);
    expect(actions).toEqual(["conclave.agenda_set", "conclave.agenda_set", "conclave.agenda_clear"]);
  });

  it("accepts text-only agendas and rejects an empty one", async () => {
    const r = await as(() => setAgenda(id, { agendaText: "9:00 Welcome" }));
    expect(r).toMatchObject({ agendaText: "9:00 Welcome", storagePath: "" });
    await expect(as(() => setAgenda(id, { name: "x.pdf" }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /api/files/*", () => {
  it("redirects to a signed link, 404s otherwise", async () => {
    const { createApp } = await import("../../app.js");
    const f = await storage.uploadFile("agendas", "a.pdf", "application/pdf", Buffer.from("x"));
    const server = createApp().listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/api/files/${f.path}`, { redirect: "manual" });
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe(`memory://${f.path}`);
      const missing = await fetch(`${base}/api/files/agendas/nope.pdf`, { redirect: "manual" });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
