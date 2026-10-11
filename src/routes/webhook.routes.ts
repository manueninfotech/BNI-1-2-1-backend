import { Router } from "express";
import { asyncHandler } from "../middleware/errors.js";
import { razorpayWebhook } from "../controllers/webhook.controller.js";

const router = Router();

// POST /api/webhooks/razorpay — payment.captured / payment.failed / refund.processed
router.post("/razorpay", asyncHandler(razorpayWebhook));

export default router;
