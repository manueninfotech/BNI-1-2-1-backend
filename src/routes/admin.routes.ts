import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import * as c from "../controllers/admin.controller.js";

const router = Router();

/**
 * The entire admin surface is guarded here, in ONE place, so a new route cannot
 * be added unprotected by accident. Every handler below can assume req.uid is a
 * verified administrator.
 */
router.use(requireAdmin);

// Conclaves
router.get("/conclaves", asyncHandler(c.list));
router.post("/conclaves", asyncHandler(c.create));
router.patch("/conclaves/:id", asyncHandler(c.update));

// Lifecycle
router.post("/conclaves/:id/registration", asyncHandler(c.setRegistration));
router.post("/conclaves/:id/cancel", asyncHandler(c.cancel));
router.post("/conclaves/:id/complete", asyncHandler(c.complete));
router.post("/conclaves/:id/start-round", asyncHandler(c.startRound));

// Scheduling
router.post("/conclaves/:id/generate-schedule", asyncHandler(c.generate));

// People
router.get("/conclaves/:id/registrations", asyncHandler(c.registrations));
router.post("/conclaves/:id/registrations/:uid/role", asyncHandler(c.setRole));

// Dashboard
router.get("/conclaves/:id/stats", asyncHandler(c.statistics));

// Members
router.get("/users/search", asyncHandler(c.findUser));
router.post("/users/:uid/reset-link", asyncHandler(c.resetLink));

export default router;
