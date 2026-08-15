import crypto from "node:crypto";
import Razorpay from "razorpay";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Razorpay integration for the registration fee.
 *
 * The security model here is deliberate and non-negotiable, because it guards
 * real money:
 *
 *   1. The SECRET key never leaves this process. The app only ever receives the
 *      public key_id and an order id.
 *   2. The SERVER decides the amount, from the conclave's registrationFee. A
 *      client-supplied amount is never trusted for what gets charged or checked.
 *   3. verifyPayment() proves BOTH that the (order, payment) pair is genuinely
 *      Razorpay's AND that the amount actually captured matches what we expect.
 *      A signature alone only proves the pair is real — a member could pay a ₹1
 *      order and submit a valid signature for a ₹1500 registration.
 *   4. It FAILS CLOSED. If Razorpay can't confirm capture, we reject rather than
 *      record an unverified payment.
 *
 * Ported from the proven pattern in sujatha-backend/service/razorpay.js.
 */

let _client: Razorpay | null = null;

/** True when Razorpay keys are configured. Lets callers degrade gracefully. */
export function razorpayConfigured(): boolean {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

/**
 * Lazily construct the client so the server still boots without keys (they may
 * not be provisioned yet). Any endpoint that actually needs Razorpay throws a
 * clear 503 instead, rather than the whole process dying at import time.
 */
function client(): Razorpay {
  if (!razorpayConfigured()) {
    throw new ApiError(503, "Online payment is not configured on the server yet.");
  }
  if (!_client) {
    _client = new Razorpay({
      key_id: env.razorpayKeyId,
      key_secret: env.razorpayKeySecret,
    });
  }
  return _client;
}

/**
 * Open a Razorpay order for `amountRupees`, tagged with who it's for.
 *
 * The notes stamp the payer and conclave onto the Razorpay record, so a payment
 * that never became a registration can still be traced back and refunded from
 * the dashboard alone.
 */
export async function createOrder(params: {
  amountRupees: number;
  uid: string;
  conclaveId: string;
}): Promise<{ orderId: string; amount: number; currency: string; key: string }> {
  const { amountRupees, uid, conclaveId } = params;

  if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
    throw ApiError.badRequest("This conclave has no registration fee to pay.");
  }
  // Razorpay's floor is 100 paise (₹1).
  if (amountRupees < 1) {
    throw ApiError.badRequest("The registration fee is below the minimum online payment of ₹1.");
  }

  const order = await client().orders.create({
    amount: Math.round(amountRupees * 100), // rupees → paise
    currency: "INR",
    receipt: `conclave_${conclaveId}_${uid}`.slice(0, 40),
    payment_capture: true,
    notes: { uid, conclaveId },
  });

  return {
    orderId: order.id,
    amount: Number(order.amount),
    currency: order.currency,
    key: env.razorpayKeyId,
  };
}

/**
 * Confirm that `expectedRupees` was actually captured for this order.
 *
 * @throws ApiError(400) if the signature is wrong, the order is not paid, or the
 *         captured amount does not match. Fails closed on a Razorpay outage.
 */
export async function verifyPayment(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  expectedRupees: number;
  tolerance?: number;
}): Promise<{ paidRupees: number }> {
  const { orderId, paymentId, signature, expectedRupees, tolerance = 1 } = params;

  if (!orderId || !paymentId || !signature) {
    throw ApiError.badRequest("Incomplete payment details.");
  }

  // 1. The (order, payment) pair genuinely came from Razorpay.
  const expected = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.badRequest("Invalid payment signature.");
  }

  // 2. Money actually moved, and it was the right amount. Fails closed.
  let order: { status?: string; amount_paid?: number };
  try {
    order = (await client().orders.fetch(orderId)) as typeof order;
  } catch (err: any) {
    const detail =
      err?.error?.description || err?.description || err?.message ||
      (err?.statusCode ? `HTTP ${err.statusCode}` : "unknown error");
    throw new ApiError(502, `Could not verify payment with Razorpay: ${detail}`);
  }

  if (order.status !== "paid") {
    throw ApiError.badRequest(`Payment not captured (order status: ${order.status}).`);
  }

  const paidRupees = (order.amount_paid ?? 0) / 100;
  if (Math.abs(paidRupees - expectedRupees) > tolerance) {
    throw ApiError.badRequest(
      `Amount mismatch: ₹${paidRupees} captured, ₹${expectedRupees} expected.`,
    );
  }

  return { paidRupees };
}
