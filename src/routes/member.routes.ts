import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { syncLimiter } from "../middleware/rateLimit.js";
import * as c from "../controllers/member.controller.js";

const router = Router();

/**
 * Member endpoints. Every one requires a verified Firebase token — the caller's
 * uid is taken from that token and NEVER from the request body.
 *
 * This was the single worst hole in the previous backend: /sync was completely
 * unauthenticated and took `userId` from the body, so anyone who knew a conclave
 * id could forge attendance and referrals for anybody, and read any member's
 * referrals by simply asking for them.
 */
router.use(requireUser);

router.get("/me", asyncHandler(c.me));
router.get("/conclaves", asyncHandler(c.listConclaves));
router.post("/conclaves/:id/register", asyncHandler(c.register));
router.post("/conclaves/:id/sync", syncLimiter, asyncHandler(c.syncConclave));

export default router;
