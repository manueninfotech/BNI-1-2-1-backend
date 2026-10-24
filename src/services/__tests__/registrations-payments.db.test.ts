import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Razorpay and Firebase are faked; data is real Postgres.
const orders = new Map<string, { status: string; amount_paid: number; notes: Record<string, string> }>();
vi.mock("razorpay", () => ({
  default: class {
    orders = {
      fetch: async (id: string) => {
        const o = orders.get(id);
        if (!o) throw new Error("not found");
        return o;
      },
      create: async () => ({ id: "order_new", amount: 50000, currency: "INR" }),
    };
  },
}));
vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  messaging: new Proxy({}, { get: () => async () => "ok" }),
  auth: {},
}));
vi.mock("../../config/env.js", async (orig) => {
  const real: any = await orig();
  return { ...real, env: { ...real.env, razorpayKeyId: "rzp_test_x", razorpayKeySecret: "secret", razorpayWebhookSecret: "whsec" } };
});

const crypto = await import("node:crypto");
const { pgdb, pool } = await import("../../db/client.js");
const { auditLog, conclaves, payments, registrations, users } = await import("../../db/schema.js");
const { runWithContext } = await import("../../observability/context.js");
const reg = await import("../registration.service.js");
const roles = await import("../role.service.js");
const pay = await import("../payments.service.js");

const sign = (orderId: string, paymentId: string) => crypto.createHmac("sha256", "secret").update(`${orderId}|${paymentId}`).digest("hex");
async function as<T>(uid: string, fn: () => Promise<T>) {
  const requestId = `t-${Math.random().toString(36).slice(2)}`;
  const result = await runWithContext({ requestId, source: "mobile_app", actor: { uid, role: "member" }, changeCount: 0 }, fn);
  return { result, requestId };
}
const auditFor = (requestId: string) => pgdb.select().from(auditLog).where(eq(auditLog.requestId, requestId)).orderBy(auditLog.id);
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

async function conclave(over: Partial<typeof conclaves.$inferInsert> = {}) {
  const [c] = await pgdb
    .insert(conclaves)
    .values({ name: "C", venueLocation: "Hall", startDate: days(10), status: "registrationOpen", isRegistrationOpen: true, ...over })
    .returning();
  return c.id;
}

beforeEach(async () => {
  orders.clear();
  await pgdb.execute(sql`TRUNCATE conclaves, users, payments CASCADE`);
  await pgdb.insert(users).values([{ uid: "m1", name: "Asha" }, { uid: "m2", name: "Bala" }]);
});
afterAll(async () => {
  await pool.end();
});

describe("free registration", () => {
  it("registers once (idempotent), updates the profile, and audits both", async () => {
    const id = await conclave();
    const { result, requestId } = await as("m1", () => reg.register(id, "m1", { phone: "9515409973", company: "Glassworks" }));
    expect(result).toEqual({ alreadyRegistered: false });
    expect((await as("m1", () => reg.register(id, "m1"))).result).toEqual({ alreadyRegistered: true });

    const actions = (await auditFor(requestId)).map((r) => r.action);
    expect(actions).toEqual(["registration.create", "user.update"]);
    const [u] = await pgdb.select().from(users).where(eq(users.uid, "m1"));
    expect(u).toMatchObject({ phone: "+919515409973", company: "Glassworks" });
  });

  it("refuses when registration is closed or the times clash", async () => {
    const closed = await conclave({ isRegistrationOpen: false, status: "registrationClosed" });
    await expect(as("m1", () => reg.register(closed, "m1"))).rejects.toMatchObject({ status: 409 });

    const a = await conclave({ name: "A", startDate: days(10) });
    const b = await conclave({ name: "B", startDate: days(10) });
    await as("m1", () => reg.register(a, "m1"));
    await expect(as("m1", () => reg.register(b, "m1"))).rejects.toMatchObject({ status: 409, details: { conflictsWith: { name: "A" } } });
  });
});

describe("paid registration", () => {
  const paid = (fee = 500) => conclave({ registrationFee: fee, paymentDetails: { registrationFee: fee } });

  it("requires a payment, and accepts a verified one bound to this member + conclave", async () => {
    const id = await paid();
    await expect(as("m1", () => reg.register(id, "m1"))).rejects.toMatchObject({ status: 400, details: { paymentRequired: true } });

    orders.set("order_1", { status: "paid", amount_paid: 50000, notes: { uid: "m1", conclaveId: id } });
    await as("m1", () => reg.register(id, "m1", { payment: { method: "online", orderId: "order_1", paymentId: "pay_1", signature: sign("order_1", "pay_1") } }));
    const [r] = await pgdb.select().from(registrations).where(eq(registrations.userId, "m1"));
    expect(r).toMatchObject({ status: "confirmed", paymentStatus: "paid", amountPaid: 500 });
    expect(JSON.stringify(await pgdb.select().from(auditLog).where(eq(auditLog.entityId, `${id}:m1`)))).not.toContain(sign("order_1", "pay_1"));
  });

  it("rejects a payment replayed by another member, for another conclave, or used twice", async () => {
    const x = await paid();
    const y = await paid();
    orders.set("order_1", { status: "paid", amount_paid: 50000, notes: { uid: "m1", conclaveId: x } });
    const p = { method: "online", orderId: "order_1", paymentId: "pay_1", signature: sign("order_1", "pay_1") };

    await expect(as("m2", () => reg.register(x, "m2", { payment: p }))).rejects.toThrow(/different member/);
    await expect(as("m1", () => reg.register(y, "m1", { payment: p }))).rejects.toThrow(/different conclave/);

    await as("m1", () => reg.register(x, "m1", { payment: p }));
    // Same payment id smuggled onto another order the attacker controls → DB refuses reuse.
    orders.set("order_2", { status: "paid", amount_paid: 50000, notes: { uid: "m2", conclaveId: x } });
    await expect(
      as("m2", () => reg.register(x, "m2", { payment: { method: "online", orderId: "order_2", paymentId: "pay_1", signature: sign("order_2", "pay_1") } })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a wrong amount or forged signature", async () => {
    const id = await paid(500);
    orders.set("o", { status: "paid", amount_paid: 10000, notes: { uid: "m1", conclaveId: id } });
    await expect(as("m1", () => reg.register(id, "m1", { payment: { method: "online", orderId: "o", paymentId: "p", signature: sign("o", "p") } }))).rejects.toThrow(/Amount mismatch/);
    await expect(as("m1", () => reg.register(id, "m1", { payment: { method: "online", orderId: "o", paymentId: "p", signature: "forged" } }))).rejects.toThrow(/signature/);
  });
});

describe("withdraw and roles", () => {
  it("withdraw: allowed before a schedule; refused once scheduled or paid", async () => {
    const id = await conclave();
    await as("m1", () => reg.register(id, "m1"));
    const { requestId } = await as("m1", () => reg.deregister(id, "m1"));
    expect((await auditFor(requestId))[0]).toMatchObject({ action: "registration.withdraw" });

    await as("m1", () => reg.register(id, "m1"));
    await pgdb.update(conclaves).set({ schedule: { rounds: [] } }).where(eq(conclaves.id, id));
    await expect(as("m1", () => reg.deregister(id, "m1"))).rejects.toMatchObject({ status: 409 });

    const id2 = await conclave({ name: "Paid", startDate: days(30) });
    await pgdb.insert(registrations).values({ conclaveId: id2, userId: "m2", paymentStatus: "paid" });
    await expect(as("m2", () => reg.deregister(id2, "m2"))).rejects.toMatchObject({ status: 409 });
  });

  it("role changes are audited and frozen once running", async () => {
    const id = await conclave();
    await as("m1", () => reg.register(id, "m1"));
    const { requestId } = await as("admin", () => roles.setRole(id, "m1", "captain"));
    expect((await auditFor(requestId))[0].changes).toEqual({ role: { from: "member", to: "captain" } });
    await pgdb.update(conclaves).set({ status: "running" }).where(eq(conclaves.id, id));
    await expect(as("admin", () => roles.setRole(id, "m1", "member"))).rejects.toMatchObject({ status: 409 });
    await expect(as("admin", () => roles.setRole(id, "m1", "boss" as any))).rejects.toMatchObject({ status: 400 });
  });
});

describe("payment ledger (webhook)", () => {
  const event = (type: string, entity: Record<string, unknown>) => ({ event: type, payload: { payment: { entity } } });

  it("records captures idempotently, never demotes a capture, keeps the amount on refund", async () => {
    const id = await conclave({ name: "Paid" });
    orders.set("order_9", { status: "paid", amount_paid: 50000, notes: { uid: "m1", conclaveId: id } });
    const captured = event("payment.captured", { id: "pay_9", order_id: "order_9", amount: 50000, status: "captured", method: "upi" });

    await pay.recordPaymentEvent(captured);
    await pay.recordPaymentEvent(captured); // redelivery
    await pay.recordPaymentEvent(event("payment.failed", { id: "pay_9", order_id: "order_9", amount: 50000, status: "failed" }));
    let [row] = await pgdb.select().from(payments).where(eq(payments.paymentId, "pay_9"));
    expect(row).toMatchObject({ status: "captured", amount: 500, conclaveId: id, uid: "m1" });

    await pay.recordPaymentEvent({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_9", amount: 20000 } } } });
    [row] = await pgdb.select().from(payments).where(eq(payments.paymentId, "pay_9"));
    expect(row).toMatchObject({ status: "refunded", amount: 500, refundedAmount: 200 });

    const revenue = await pay.getRevenue();
    expect(revenue).toMatchObject({ totalRevenue: 300, refundedTotal: 200, capturedCount: 1 });
    const audits = await pgdb.select().from(auditLog).where(and(eq(auditLog.entityType, "payment"), eq(auditLog.entityId, "pay_9")));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["payment.captured", "payment.refunded"]));
  });

  it("verifies webhook signatures and fails closed", () => {
    const body = Buffer.from('{"event":"x"}');
    const good = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
    expect(pay.verifyWebhookSignature(body, good)).toBe(true);
    expect(pay.verifyWebhookSignature(body, "nope")).toBe(false);
    expect(pay.verifyWebhookSignature(undefined, good)).toBe(false);
  });

  it("per-conclave view lists members and failed attempts by non-registrants", async () => {
    const id = await conclave();
    await pgdb.insert(registrations).values({ conclaveId: id, userId: "m1", paymentStatus: "paid", payment: { method: "online", amount: 500 } });
    await pgdb.insert(payments).values({ paymentId: "pf", conclaveId: id, uid: "m2", status: "failed", amount: 500 });
    const v = await pay.getConclavePayments(id);
    expect(v.counts).toEqual({ paid: 1, pending: 0, failed: 1, total: 1 });
  });
});
