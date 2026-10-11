import crypto from "node:crypto";
import { db, collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { fetchOrderNotes } from "./razorpay.service.js";

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

const paymentsRef = () => db.collection(collections.payments);

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
 * Records one verified webhook event into the ledger. Idempotent: keyed on the
 * Razorpay payment id, so a redelivered event just re-writes the same doc. A
 * capture never gets overwritten by a late-arriving earlier state.
 */
export async function recordPaymentEvent(event: any): Promise<{ ok: boolean; paymentId?: string }> {
  const type: string = event?.event ?? "";
  const payment = event?.payload?.payment?.entity;
  const refund = event?.payload?.refund?.entity;
  const entity = payment ?? (refund ? { ...refund, id: refund.payment_id } : null);
  if (!entity?.id) return { ok: false };

  const paymentId: string = refund ? refund.payment_id : entity.id;
  const orderId: string = entity.order_id ?? "";

  // Attribute the payment to a member + conclave via the order's notes.
  const notes = {
    ...(await fetchOrderNotes(orderId)),
    ...(entity.notes ?? {}),
  } as Record<string, string>;

  const status = ledgerStatus(type, entity.status);
  const amountRupees = Math.round(Number(entity.amount ?? 0)) / 100;

  const docRef = paymentsRef().doc(paymentId);

  // A capture is terminal for revenue — don't let a stray later "failed" for the
  // same id (shouldn't happen, but webhooks can be odd) demote it.
  if (status === "failed") {
    const existing = await docRef.get();
    if (existing.exists && existing.data()?.status === "captured") {
      return { ok: true, paymentId };
    }
  }

  const base: Record<string, any> = {
    paymentId,
    orderId,
    conclaveId: notes.conclaveId ?? null,
    uid: notes.uid ?? null,
    amount: amountRupees,
    currency: entity.currency ?? "INR",
    status,
    method: entity.method ?? null,
    email: entity.email ?? null,
    contact: entity.contact ?? null,
    errorDescription: entity.error_description ?? null,
    lastEvent: type,
    updatedAt: new Date(),
  };

  // Set createdAt only on first write.
  await docRef.set({ createdAt: new Date(), ...base }, { merge: true });

  if (refund) {
    await docRef.set(
      {
        refundedAmount: Math.round(Number(refund.amount ?? 0)) / 100,
        refundId: refund.id ?? null,
        refundedAt: new Date(),
      },
      { merge: true },
    );
  }

  return { ok: true, paymentId };
}

// --- Admin reads -------------------------------------------------------------

type PaymentDoc = {
  paymentId: string;
  orderId: string;
  conclaveId: string | null;
  uid: string | null;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  email: string | null;
  contact: string | null;
  errorDescription: string | null;
  refundedAmount?: number;
  createdAt?: any;
};

function toIso(v: any): string | null {
  const d = v?.toDate?.() ?? (v instanceof Date ? v : null);
  return d ? d.toISOString() : null;
}

async function allPayments(): Promise<PaymentDoc[]> {
  const snap = await paymentsRef().get();
  return snap.docs.map((d) => d.data() as PaymentDoc);
}

/**
 * Super-admin revenue: total captured (net of refunds), a per-conclave
 * breakdown, a daily time series, and captured-vs-failed counts for v1 charts.
 */
export async function getRevenue(): Promise<any> {
  const payments = await allPayments();
  const conclaves = await db.collection(collections.conclaves).get();
  const nameById = new Map<string, string>();
  conclaves.docs.forEach((c) => nameById.set(c.id, (c.data() as any).name ?? c.id));

  let capturedTotal = 0;
  let refundedTotal = 0;
  let capturedCount = 0;
  let failedCount = 0;
  const byConclave = new Map<string, { conclaveId: string; name: string; revenue: number; payments: number; failed: number }>();
  const byDay = new Map<string, { date: string; revenue: number; count: number }>();

  for (const p of payments) {
    const cid = p.conclaveId ?? "unattributed";
    const row =
      byConclave.get(cid) ??
      { conclaveId: cid, name: nameById.get(cid) ?? "Unattributed", revenue: 0, payments: 0, failed: 0 };

    if (p.status === "captured") {
      const net = (p.amount ?? 0) - (p.refundedAmount ?? 0);
      capturedTotal += net;
      capturedCount += 1;
      row.revenue += net;
      row.payments += 1;

      const day = toIso(p.createdAt)?.slice(0, 10) ?? "unknown";
      const d = byDay.get(day) ?? { date: day, revenue: 0, count: 0 };
      d.revenue += net;
      d.count += 1;
      byDay.set(day, d);
    } else if (p.status === "failed") {
      failedCount += 1;
      row.failed += 1;
    }
    if (p.refundedAmount) refundedTotal += p.refundedAmount;

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

/** Super-admin: the most recent payments across all conclaves (live feed). */
export async function listTransactions(limit = 50): Promise<any> {
  const snap = await paymentsRef().orderBy("createdAt", "desc").limit(limit).get().catch(() => paymentsRef().limit(limit).get());
  const conclaves = await db.collection(collections.conclaves).get();
  const nameById = new Map<string, string>();
  conclaves.docs.forEach((c) => nameById.set(c.id, (c.data() as any).name ?? c.id));
  const items = snap.docs.map((d) => {
    const p = d.data() as PaymentDoc;
    return {
      paymentId: p.paymentId,
      conclaveId: p.conclaveId,
      conclaveName: p.conclaveId ? nameById.get(p.conclaveId) ?? "Unattributed" : "Unattributed",
      amount: p.amount,
      status: p.status,
      method: p.method,
      email: p.email,
      contact: p.contact,
      errorDescription: p.errorDescription,
      createdAt: toIso((p as any).createdAt),
    };
  });
  return { count: items.length, items };
}

/**
 * Conclave-admin: each registered member's payment status, PLUS failed attempts
 * (from the ledger) that never produced a registration — the whole point of the
 * webhook for an organiser chasing unpaid members.
 */
export async function getConclavePayments(conclaveId: string): Promise<any> {
  const regsSnap = await db
    .collection(collections.conclaves)
    .doc(conclaveId)
    .collection(collections.registrations)
    .get();

  const members = regsSnap.docs.map((d) => {
    const r: any = d.data();
    const pay = r.payment ?? {};
    return {
      uid: d.id,
      name: r.name ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      registrationStatus: r.status ?? "pending",
      paymentStatus: pay.status ?? (r.status === "confirmed" ? "paid" : "pending"),
      paymentMethod: pay.method ?? null,
      amount: pay.amount ?? null,
      paymentId: pay.paymentId ?? null,
      paidAt: toIso(pay.paidAt),
    };
  });

  // Failed attempts for this conclave whose member never registered.
  const registeredUids = new Set(members.map((m) => m.uid));
  const ledger = (await allPayments()).filter((p) => p.conclaveId === conclaveId);
  const failedOnly = ledger
    .filter((p) => p.status === "failed" && (!p.uid || !registeredUids.has(p.uid)))
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

  const paidCount = members.filter((m) => m.paymentStatus === "paid").length;
  const pendingCount = members.filter((m) => m.paymentStatus === "pending").length;

  return {
    conclaveId,
    counts: {
      paid: paidCount,
      pending: pendingCount,
      failed: failedOnly.length,
      total: members.length,
    },
    members,
    failedAttempts: failedOnly,
  };
}
