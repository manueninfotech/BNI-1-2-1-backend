import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Local-dev identity mode: X-User-Id is the caller (no Firebase in tests).
vi.mock("../../config/env.js", async (orig) => {
  const real: any = await orig();
  return { ...real, env: { ...real.env, allowInsecureAdmin: true } };
});
vi.mock("../../config/firebase.js", () => ({
  messaging: new Proxy({}, { get: () => async () => "ok" }),
  auth: { verifyIdToken: async () => { throw new Error("no"); } },
}));

const { pgdb, pool } = await import("../../db/client.js");
const { conclaves, users } = await import("../../db/schema.js");
const storage = await import("../storage.service.js");
const { closeListener } = await import("../live.service.js");
const { createApp } = await import("../../app.js");
const { runWithContext } = await import("../../observability/context.js");
const svc = await import("../conclave.service.js");

const mem = storage.memoryProvider();
storage.setStorageProvider(mem);

let server: Server;
let base = "";
let conclaveId = "";
const get = (path: string, uid = "m1") => fetch(`${base}/api${path}`, { headers: { "X-User-Id": uid } });
const send = (method: string, path: string, body: unknown, uid = "m1") =>
  fetch(`${base}/api${path}`, { method, headers: { "X-User-Id": uid, "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  await pgdb.execute(sql`TRUNCATE conclaves, users, settings CASCADE`);
  await pgdb.insert(users).values({ uid: "m1", name: "Asha", phone: "+919000000001" });
  const [c] = await pgdb
    .insert(conclaves)
    .values({ name: "Live", startDate: new Date(), status: "running", currentRound: 1, currentRoundStartedAt: new Date(), participants: [{ id: 1, name: "B", phone: "+919999999999", _originalUid: "b" }] })
    .returning();
  conclaveId = c.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await closeListener();
  storage.setStorageProvider(null);
  await pool.end();
});

describe("app data endpoints", () => {
  it("GET /app-config returns categories, round timing and auto-logout", async () => {
    const j: any = await (await get("/app-config")).json();
    expect(j).toMatchObject({ roundTiming: { bioSeconds: 60, referralSeconds: 30, bufferSeconds: 120 }, autoLogoutHours: 5 });
    expect(Array.isArray(j.categories)).toBe(true);
  });

  it("GET /conclaves/:id returns detail without other attendees' phones", async () => {
    const r = await get(`/conclaves/${conclaveId}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('"name":"Live"');
    expect(text).not.toContain("9999999999");
    expect((await get("/conclaves/nope")).status).toBe(404);
  });

  it("profile: full own profile, extended fields editable, photo set and removed", async () => {
    await send("PUT", "/me", { lookingFor: "Exporters", canOffer: "Glass", membership: "Gold" });
    const p = await (await get("/me/profile")).json();
    expect(p).toMatchObject({ name: "Asha", phone: "+919000000001", lookingFor: "Exporters", canOffer: "Glass", membership: "Gold" });

    const png = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
    const set: any = await (await send("PUT", "/me/photo", { dataUrl: png })).json();
    expect(set.photoUrl).toMatch(/^\/api\/files\/avatars\//);
    expect(mem.files.size).toBe(1);
    expect((await send("PUT", "/me/photo", { dataUrl: "data:application/pdf;base64,AA==" })).status).toBe(400);
    await fetch(`${base}/api/me/photo`, { method: "DELETE", headers: { "X-User-Id": "m1" } });
    expect(mem.files.size).toBe(0);
    expect(((await (await get("/me/profile")).json()) as any).photoUrl).toBeNull();
  });
});

describe("live stream (SSE + LISTEN/NOTIFY)", () => {
  it("sends the current state on connect and pushes each committed change", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/conclaves/${conclaveId}/live`, { headers: { "X-User-Id": "m1" }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const events: any[] = [];
    const pump = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })();

    const until = async (pred: () => boolean) => {
      for (let t = 0; t < 50 && !pred(); t++) await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => events.length >= 1);
    expect(events[0]).toMatchObject({ id: conclaveId, status: "running", isRoundPaused: false });

    await runWithContext({ requestId: "live-test", source: "admin_panel", actor: { uid: "adm", role: "admin" }, changeCount: 0 }, () => svc.pauseRound(conclaveId));
    await until(() => events.length >= 2);
    expect(events.at(-1)).toMatchObject({ id: conclaveId, isRoundPaused: true });

    ctrl.abort();
    await pump;
    const [row] = await pgdb.select().from(conclaves).where(eq(conclaves.id, conclaveId));
    expect(row.isRoundPaused).toBe(true);
  });
});
