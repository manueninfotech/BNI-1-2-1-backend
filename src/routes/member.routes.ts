import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { syncLimiter, paymentOrderLimiter } from "../middleware/rateLimit.js";
import * as c from "../controllers/member.controller.js";

const router = Router();

router.post("/auth/resolve-identifier", asyncHandler(c.resolveIdentifier));

/**
 * Member endpoints. Every one requires a verified Firebase token — the caller's
 * uid is taken from that token and NEVER from the request body.
 */
router.use(requireUser);

router.get("/me", asyncHandler(c.me));
router.put("/me", asyncHandler(c.updateMe));
router.patch("/me", asyncHandler(c.updateMe));
router.delete("/me/account", asyncHandler(c.deleteAccount));
router.get("/members", asyncHandler(c.listMembers));
router.get("/me/referrals", asyncHandler(c.myReferrals));
router.patch("/conclaves/:cid/referrals/:rid/outcome", asyncHandler(c.updateReferralOutcome));
router.get("/me/one-to-ones", asyncHandler(c.listOneToOnes));
router.post("/me/one-to-ones", asyncHandler(c.createOneToOne));
router.patch("/me/one-to-ones/:id", asyncHandler(c.updateOneToOne));
router.get("/me/notifications", asyncHandler(c.listNotifications));
router.post("/me/notifications/read", asyncHandler(c.markNotificationsRead));
router.get("/conclaves", asyncHandler(c.listConclaves));
router.get("/conclaves/:id/referrals", asyncHandler(c.getReferrals));
router.post("/conclaves/:id/payment/order", paymentOrderLimiter, asyncHandler(c.createPaymentOrder));
router.post("/conclaves/:id/register", asyncHandler(c.register));
router.delete("/conclaves/:id/register", asyncHandler(c.deregister));
router.post("/conclaves/:id/sync", syncLimiter, asyncHandler(c.syncConclave));

export default router;
