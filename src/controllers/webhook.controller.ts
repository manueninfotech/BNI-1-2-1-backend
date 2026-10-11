import type { Request, Response } from "express";
import { verifyWebhookSignature, recordPaymentEvent } from "../services/payments.service.js";

/**
 * Razorpay webhook receiver.
 *
 * Public by design — Razorpay carries no bearer token, it proves itself with the
 * `X-Razorpay-Signature` HMAC over the raw body. Everything is gated on that
 * signature (fails closed), so an unsigned or forged call is rejected before any
 * state is touched. We acknowledge fast with a 2xx; a 5xx tells Razorpay to retry.
 */
export async function razorpayWebhook(req: Request, res: Response) {
  const signature = req.header("x-razorpay-signature");
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: "Invalid or missing signature." });
  }

  try {
    await recordPaymentEvent(req.body);
  } catch (e) {
    // Returning 5xx asks Razorpay to redeliver — our record step is idempotent,
    // so a retry is safe.
    console.error("Razorpay webhook processing failed:", e);
    return res.status(500).json({ error: "processing_failed" });
  }

  return res.status(200).json({ ok: true });
}
