import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import { eq, sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import { pgdb, pool } from "../../db/client.js";
import { auditLog } from "../../db/schema.js";
import { audit, diff, redact } from "../audit.service.js";
import { requestContext } from "../../middleware/requestContext.js";
import { ApiError, asyncHandler, errorHandler } from "../../middleware/errors.js";
import { runAsSystem, runWithContext, setActor } from "../../observability/context.js";

afterAll(async () => {
  await pool.end();
});

const rowsFor = (requestId: string) =>
  pgdb.select().from(auditLog).where(eq(auditLog.requestId, requestId)).orderBy(auditLog.id);

describe("redact", () => {
  it("masks secrets and omits bulky payloads", () => {
    const out = redact({
      password: "hunter2",
      razorpaySignature: "abc",
      idToken: "eyJ...",
      agenda: { dataUrl: "data:application/pdf;base64,AAAA", name: "a.pdf" },
      note: "x".repeat(1500),
      nested: { apiKey: "k", ok: 1 },
    }) as any;
    expect(out.password).toBe("[redacted]");
    expect(out.razorpaySignature).toBe("[redacted]");
    expect(out.idToken).toBe("[redacted]");
    expect(out.agenda.dataUrl).toBe("[omitted]");
    expect(out.agenda.name).toBe("a.pdf");
    expect(out.note).toMatch(/…\[\+500 chars\]$/);
    expect(out.nested).toEqual({ apiKey: "[redacted]", ok: 1 });
  });
});

describe("diff", () => {
  it("returns only changed fields and ignores noise", () => {
    expect(
      diff(
        { name: "A", status: "open", updatedAt: 1, roundCount: 4 },
        { name: "B", status: "open", updatedAt: 2, roundCount: 4, venue: "Hall" },
      ),
    ).toEqual({ name: { from: "A", to: "B" }, venue: { from: null, to: "Hall" } });
  });

  it("returns null when nothing meaningful changed", () => {
    expect(diff({ a: 1, updatedAt: 1 }, { a: 1, updatedAt: 2 })).toBeNull();
  });
});

describe("audit.change", () => {
  it("attributes the change to the current actor and request", async () => {
    const requestId = `test-change-${Date.now()}`;
    await runWithContext(
      { requestId, source: "admin_panel", actor: { uid: null, role: "anonymous" }, changeCount: 0, ip: "10.0.0.1" },
      async () => {
        setActor({ uid: "admin-1", role: "superadmin", email: "boss@bni.com" });
        await audit.change({
          action: "conclave.update",
          entityType: "conclave",
          entityId: "c1",
          before: { name: "Old", date: "2026-11-01" },
          after: { name: "New", date: "2026-11-01" },
        });
      },
    );
    const [row] = await rowsFor(requestId);
    expect(row).toMatchObject({
      kind: "change",
      action: "conclave.update",
      actorUid: "admin-1",
      actorRole: "superadmin",
      actorEmail: "boss@bni.com",
      source: "admin_panel",
      ip: "10.0.0.1",
      entityType: "conclave",
      entityId: "c1",
      conclaveId: "c1",
      changes: { name: { from: "Old", to: "New" } },
    });
  });

  it("rolls back with the transaction it belongs to", async () => {
    const requestId = `test-tx-${Date.now()}`;
    await runWithContext(
      { requestId, source: "admin_panel", actor: { uid: "a", role: "admin" }, changeCount: 0 },
      () =>
        pgdb
          .transaction(async (tx) => {
            await audit.change({ action: "x.update", entityType: "x", entityId: "1", after: { a: 1 } }, tx);
            throw new Error("boom");
          })
          .catch(() => {}),
    );
    expect(await rowsFor(requestId)).toHaveLength(0);
  });

  it("marks scheduled jobs as system actions", async () => {
    let requestId = "";
    await runAsSystem("reminders", async () => {
      await audit.system("job.run", { sent: 3 });
      requestId = (await import("../../observability/context.js")).currentContext()!.requestId;
    });
    const [row] = await rowsFor(requestId);
    expect(row).toMatchObject({ kind: "system", action: "job.run", actorRole: "system", actorName: "reminders" });
  });
});

describe("audit_log is append-only", () => {
  it("rejects UPDATE and DELETE", async () => {
    await expect(pgdb.execute(sql`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow();
    await expect(pgdb.execute(sql`DELETE FROM audit_log`)).rejects.toThrow();
  });
});

describe("requestContext middleware (end to end)", () => {
  async function withServer(fn: (base: string) => Promise<void>) {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.get("/api/thing/:id", (_req, res) => {
      res.json({ ok: true });
    });
    app.patch("/api/admin/conclaves/:id", async (req, res) => {
      setActor({ uid: "admin-9", role: "admin", email: "a@bni.com" });
      await audit.change({
        action: "conclave.update",
        entityType: "conclave",
        entityId: req.params.id,
        before: { name: "A" },
        after: { name: req.body.name },
      });
      res.json({ ok: true });
    });
    app.post("/api/admin/secret", (_req, res) => {
      res.status(403).json({ error: "nope" });
    });
    const router = express.Router();
    router.patch(
      "/conclaves/:id/fail",
      asyncHandler(async () => {
        throw new ApiError(409, "Cannot edit a conclave that is running.");
      }),
    );
    app.use("/api/admin", router);
    app.use(errorHandler);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 150)); // request rows are written after the response

  it("writes a request row linked to the change row, with a redacted body", async () => {
    const requestId = `test-e2e-${Date.now()}`;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/admin/conclaves/c42`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Request-Id": requestId, "X-Client": "admin-panel/2.0" },
        body: JSON.stringify({ name: "B", password: "should-not-be-stored" }),
      });
      expect(res.headers.get("x-request-id")).toBe(requestId);
    });
    await settle();
    const rows = await rowsFor(requestId);
    expect(rows.map((r) => r.kind)).toEqual(["change", "request"]);
    const [change, request] = rows;
    expect(change).toMatchObject({ actorUid: "admin-9", changes: { name: { from: "A", to: "B" } } });
    expect(request).toMatchObject({
      action: "http.PATCH",
      route: "/api/admin/conclaves/:id",
      entityId: "c42",
      conclaveId: "c42",
      statusCode: 200,
      outcome: "success",
      source: "admin_panel",
      actorUid: "admin-9",
    });
    expect((request.metadata as any).body).toEqual({ name: "B", password: "[redacted]" });
    expect((request.metadata as any).changes).toBe(1);
  });

  it("does not log plain reads", async () => {
    const requestId = `test-read-${Date.now()}`;
    await withServer(async (base) => {
      await fetch(`${base}/api/thing/1`, { headers: { "X-Request-Id": requestId } });
    });
    await settle();
    expect(await rowsFor(requestId)).toHaveLength(0);
  });

  it("keeps the route and record ids on a FAILED request", async () => {
    const requestId = `test-fail-${Date.now()}`;
    await withServer(async (base) => {
      await fetch(`${base}/api/admin/conclaves/c77/fail`, { method: "PATCH", headers: { "X-Request-Id": requestId, "Content-Type": "application/json" }, body: "{}" });
    });
    await settle();
    const [row] = await rowsFor(requestId);
    expect(row).toMatchObject({
      statusCode: 409,
      outcome: "failure",
      route: "/api/admin/conclaves/:id/fail",
      conclaveId: "c77",
      entityId: "c77",
      error: "Cannot edit a conclave that is running.",
    });
  });

  it("logs refused requests as denied", async () => {
    const requestId = `test-denied-${Date.now()}`;
    await withServer(async (base) => {
      await fetch(`${base}/api/admin/secret`, { method: "POST", headers: { "X-Request-Id": requestId } });
    });
    await settle();
    const [row] = await rowsFor(requestId);
    expect(row).toMatchObject({ kind: "request", statusCode: 403, outcome: "denied", actorRole: "anonymous" });
  });
});
