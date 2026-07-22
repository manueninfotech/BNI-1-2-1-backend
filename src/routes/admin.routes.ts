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
router.get("/conclaves/:id", asyncHandler(c.getOne));
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
router.get("/conclaves/:id/referrals", asyncHandler(c.referrals));

// Members
router.get("/users/search", asyncHandler(c.findUser));
router.post("/users/:uid/reset-link", asyncHandler(c.resetLink));
router.get("/users", asyncHandler(c.listAllUsers));

// Superadmin Regions Management
router.get("/regions", asyncHandler(c.listRegions));
router.post("/regions", asyncHandler(c.createRegion));
router.patch("/regions/:id", asyncHandler(c.updateRegion));
router.delete("/regions/:id", asyncHandler(c.deleteRegion));

// Superadmin Coordinators Management
router.get("/coordinators", asyncHandler(c.listCoordinators));
router.post("/coordinators", asyncHandler(c.createCoordinator));
router.patch("/coordinators/:uid", asyncHandler(c.updateCoordinator));
router.post("/coordinators/:uid/reset-password", asyncHandler(c.resetCoordinatorPassword));
router.delete("/coordinators/:uid", asyncHandler(c.deleteCoordinator));

export default router;
