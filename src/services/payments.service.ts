import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, payments, registrations, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { env } from "../config/env.js";
import { fetchOrderNotes } from "./razorpay.service.js";
import { registrationFeeOf } from "./registration.service.js";

/**
 * Payment ledger, fed by the Razorpay webhook.
 *
 * A top-level `payments` collection, one doc per Razorpay payment id, records
 * every captured / failed / refunded payment. This exists ALONGSIDE the payment
 * block already stored on each registration, and earns its keep by capturing two
 * things registrations can't:
 *   1. FAILED attempts — a failed payment never becomes a registration, so it is
 *      otherwise invisible to an admin chasing "who tried and couldn't pay".
 *   2. a flat ledger for revenue — total and per-conclave totals without walking
 *      every conclave's registrations subcollection.
 *
 * The webhook proves itself with an HMAC signature (a webhook secret separate
 * from the API key); nothing here trusts a caller's claim about an amount.
 */


export function webhookConfigured(): boolean {
  return Boolean(env.razorpayWebhookSecret);
}

/**
 * Verifies the `X-Razorpay-Signature` header against the raw request body. Fails
 * closed: no secret configured, or no raw body, means "not verified".
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!webhookConfigured() || !rawBody || !signature) return false;
  const expected = crypto
    .createHmac("sha256", env.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Maps a Razorpay payment `status` onto the ledger's own vocabulary. */
function ledgerStatus(event: string, rpStatus: string | undefined): string {
  if (event.startsWith("refund.")) return "refunded";
  if (event === "payment.failed" || rpStatus === "failed") return "failed";
  if (event === "payment.captured" || rpStatus === "captured") return "captured";
  if (rpStatus === "authorized") return "authorized";
  return rpStatus || "unknown";
}

/**
 * Records one verified webhook event into the ledger (Postgres `payments`).
 * Idempotent: keyed on the Razorpay payment id, so a redelivery re-writes the
 * same row. A capture is never demoted by a late "failed"; a refund records its
 * own fields and leaves the captured amount alone. Audited as the webhook.
 */
export async function recordPaymentEvent(event: any): Promise<{ ok: boolean; paymentId?: string }> {
  const type: string = event?.event ?? "";
  const payment = event?.payload?.payment?.entity;
  const refund = event?.payload?.refund?.entity;
  const entity = payment ?? (refund ? { ...refund, id: refund.payment_id } : null);
  if (!entity?.id) return { ok: false };

  const paymentId: string = refund ? refund.payment_id : entity.id;
  const orderId: string = entity.order_id ?? "";
  const notes = { ...(await fetchOrderNotes(orderId)), ...(entity.notes ?? {}) } as Record<string, string>;
  const status = ledgerStatus(type, entity.status);

  await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(payments).where(eq(payments.paymentId, paymentId)).for("update");
    if (status === "failed" && before?.status === "captured") return;

    const patch: Partial<typeof payments.$inferInsert> = refund
      ? {
          status: "refunded",
          refundedAmount: Math.round(Number(refund.amount ?? 0)) / 100,
          refundId: refund.id ?? null,
          refundedAt: new Date(),
          lastEvent: type,
        }
      : {
          orderId: orderId || null,
          conclaveId: notes.conclaveId ?? before?.conclaveId ?? null,
          uid: notes.uid ?? before?.uid ?? null,
          amount: Math.round(Number(entity.amount ?? 0)) / 100,
          currency: entity.currency ?? "INR",
          status,
          method: entity.method ?? null,
          email: entity.email ?? null,
          contact: entity.contact ?? null,
          errorDescription: entity.error_description ?? null,
          lastEvent: type,
        };

    const [after] = await tx
      .insert(payments)
      .values({ paymentId, status, ...patch } as typeof payments.$inferInsert)
      .onConflictDoUpdate({ target: payments.paymentId, set: { ...patch, updatedAt: new Date() } })
      .returning();
    await audit.change(
      { action: `payment.${status}`, entityType: "payment", entityId: paymentId, conclaveId: after.conclaveId, before: before ?? null, after, metadata: { event: type } },
      tx,
    );
  });
  return { ok: true, paymentId };
}

// --- Admin reads -------------------------------------------------------------

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const net = (p: { amount: number | null; refundedAmount: number | null }) => (p.amount ?? 0) - (p.refundedAmount ?? 0);
const counted = (status: string) => status === "captured" || status === "refunded";

async function conclaveNames(): Promise<Map<string, string>> {
  const rows = await pgdb.select({ id: conclaves.id, name: conclaves.name }).from(conclaves);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Super-admin revenue: total captured net of refunds, per-conclave breakdown,
 * daily series, and captured-vs-failed counts.
 */
export async function getRevenue(): Promise<any> {
  const [all, names] = await Promise.all([pgdb.select().from(payments), conclaveNames()]);
  let capturedTotal = 0;
  let refundedTotal = 0;
  let capturedCount = 0;
  let failedCount = 0;
  const byConclave = new Map<string, { conclaveId: string; name: string; revenue: number; payments: number; failed: number }>();
  const byDay = new Map<string, { date: string; revenue: number; count: number }>();

  for (const p of all) {
    const cid = p.conclaveId ?? "unattributed";
    const row = byConclave.get(cid) ?? { conclaveId: cid, name: names.get(cid) ?? "Unattributed", revenue: 0, payments: 0, failed: 0 };
    if (counted(p.status)) {
      capturedTotal += net(p);
      capturedCount += 1;
      row.revenue += net(p);
      row.payments += 1;
      const day = p.createdAt.toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { date: day, revenue: 0, count: 0 };
      d.revenue += net(p);
      d.count += 1;
      byDay.set(day, d);
    } else if (p.status === "failed") {
      failedCount += 1;
      row.failed += 1;
    }
    refundedTotal += p.refundedAmount ?? 0;
    byConclave.set(cid, row);
  }

  return {
    totalRevenue: +capturedTotal.toFixed(2),
    refundedTotal: +refundedTotal.toFixed(2),
    capturedCount,
    failedCount,
    successRate: capturedCount + failedCount > 0 ? +(capturedCount / (capturedCount + failedCount)).toFixed(3) : null,
    byConclave: [...byConclave.values()].sort((a, b) => b.revenue - a.revenue),
    timeSeries: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Super-admin: the most recent payments across all conclaves. */
export async function listTransactions(limit = 50): Promise<any> {
  const [rows, names] = await Promise.all([pgdb.select().from(payments).orderBy(desc(payments.createdAt)).limit(limit), conclaveNames()]);
  const items = rows.map((p) => ({
    paymentId: p.paymentId,
    conclaveId: p.conclaveId,
    conclaveName: p.conclaveId ? names.get(p.conclaveId) ?? "Unattributed" : "Unattributed",
    amount: p.amount,
    refundedAmount: p.refundedAmount,
    status: p.status,
    method: p.method,
    email: p.email,
    contact: p.contact,
    errorDescription: p.errorDescription,
    createdAt: iso(p.createdAt),
  }));
  return { count: items.length, items };
}

/**
 * Conclave admin: every registrant's payment status, plus failed attempts by
 * people who never registered — the organiser chasing unpaid members.
 */
export async function getConclavePayments(conclaveId: string): Promise<any> {
  const [rows, ledger, [conclave]] = await Promise.all([
    pgdb
      .select({ r: registrations, u: { name: users.name, email: users.email, phone: users.phone, photoUrl: users.photoUrl } })
      .from(registrations)
      .leftJoin(users, eq(users.uid, registrations.userId))
      .where(eq(registrations.conclaveId, conclaveId)),
    pgdb.select().from(payments).where(eq(payments.conclaveId, conclaveId)),
    pgdb.select().from(conclaves).where(eq(conclaves.id, conclaveId)),
  ]);
  // A free conclave has nothing to pay: its registrations are "free", not "pending".
  const registrationFee = registrationFeeOf(conclave);
  const members = rows.map(({ r, u }) => {
    const pay = (r.payment ?? {}) as Record<string, any>;
    // The registration keeps a snapshot only when the member filled one in;
    // otherwise the profile is the source of the name and contact.
    return {
      uid: r.userId,
      name: r.name || u?.name || null,
      email: r.email || u?.email || null,
      phone: r.phone || u?.phone || null,
      photoUrl: u?.photoUrl ?? null,
      registrationStatus: r.status ?? "pending",
      paymentStatus: r.paymentStatus ?? pay.status ?? (registrationFee === 0 ? "free" : r.status === "confirmed" ? "paid" : "pending"),
      paymentMethod: pay.method ?? null,
      amount: pay.amount ?? r.amountPaid ?? null,
      paymentId: pay.paymentId ?? null,
      paidAt: pay.paidAt ?? null,
    };
  });
  const registered = new Set(members.map((m) => m.uid));
  const failedAttempts = ledger
    .filter((p) => p.status === "failed" && (!p.uid || !registered.has(p.uid)))
    .map((p) => ({
      uid: p.uid,
      name: null,
      email: p.email,
      phone: p.contact,
      registrationStatus: "not_registered",
      paymentStatus: "failed",
      paymentMethod: p.method,
      amount: p.amount,
      paymentId: p.paymentId,
      errorDescription: p.errorDescription,
      paidAt: null,
    }));
  return {
    conclaveId,
    registrationFee,
    counts: {
      paid: members.filter((m) => m.paymentStatus === "paid").length,
      free: members.filter((m) => m.paymentStatus === "free").length,
      pending: members.filter((m) => m.paymentStatus === "pending").length,
      failed: failedAttempts.length,
      total: members.length,
    },
    members,
    failedAttempts,
  };
}



