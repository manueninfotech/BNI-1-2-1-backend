import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

vi.mock("../../config/firebase.js", () => ({ auth: {} }));

const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, users, admins } = await import("../../db/schema.js");
const { listActivity } = await import("../activity.service.js");

const guntur = { uid: "adm-g", role: "admin", region: "Guntur", email: "g@x.com", name: "Ganesh", status: "Active" } as any;
const superadmin = { uid: "sup", role: "superadmin", region: "All Regions (Global)", email: "s@x.com", name: "Super", status: "Active" } as any;
let gid = "";
let vid = "";
let tag = "";

beforeEach(async () => {
  tag = `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await pgdb.execute(sql`TRUNCATE conclaves, users CASCADE`);
  await pgdb.execute(sql`DELETE FROM admins WHERE uid IN ('adm-g','sup')`);
  await pgdb.insert(users).values([{ uid: "m1", name: "Asha" }]);
  await pgdb.insert(admins).values({ uid: "adm-g", email: "g@x.com", name: "Ganesh", role: "admin", region: "Guntur" });
  const [g] = await pgdb.insert(conclaves).values({ name: "Guntur Meet", region: "Guntur Region", status: "registrationOpen" }).returning();
  const [v] = await pgdb.insert(conclaves).values({ name: "Vijayawada Meet", region: "Vijayawada", status: "registrationOpen" }).returning();
  gid = g.id;
  vid = v.id;
  // audit_log is append-only: mark this run's rows with a unique request id.
  await pgdb.insert(auditLog).values([
    { kind: "change", action: "registration.admin_remove", actorUid: "adm-g", entityType: "registration", entityId: `${gid}:m1`, conclaveId: gid, requestId: tag, ip: "1.2.3.4" },
    { kind: "change", action: "conclave.update", actorUid: "sup", entityType: "conclave", entityId: vid, conclaveId: vid, requestId: tag },
    { kind: "request", action: "http.POST", actorUid: "adm-g", conclaveId: gid, requestId: tag },
  ]);
});
afterAll(async () => {
  await pool.end();
});

const mine = (items: any[]) => items.filter((i) => i.requestId === tag);

describe("activity", () => {
  it("a regional admin sees only their region (and their own actions), without IPs", async () => {
    const { items } = await listActivity(guntur, { limit: "200" });
    const rows = mine(items);
    expect(rows.map((r) => r.action)).toEqual(["registration.admin_remove"]);
    expect(rows[0]).toMatchObject({ actor: { name: "Ganesh" }, subject: { uid: "m1", name: "Asha" }, conclave: { id: gid, name: "Guntur Meet" } });
    expect(rows[0].ip).toBeUndefined();
  });

  it("a superadmin sees every region, with IPs; request rows only when asked", async () => {
    const rows = mine((await listActivity(superadmin, { limit: "200" })).items);
    expect(rows.map((r) => r.action).sort()).toEqual(["conclave.update", "registration.admin_remove"]);
    expect(rows.find((r) => r.action === "registration.admin_remove")?.ip).toBe("1.2.3.4");
    const withReq = mine((await listActivity(superadmin, { limit: "200", includeRequests: "true" })).items);
    expect(withReq).toHaveLength(3);
  });

  it("filters by conclave", async () => {
    const rows = mine((await listActivity(superadmin, { conclaveId: vid, limit: "200" })).items);
    expect(rows.map((r) => r.conclave?.name)).toEqual(["Vijayawada Meet"]);
  });
});
