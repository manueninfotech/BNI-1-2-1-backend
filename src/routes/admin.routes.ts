import { Router } from "express";
import { requireAdmin, requireRole, requireSuperadmin } from "../middleware/auth.js";
import { queryAudit } from "../audit/audit.query.js";
import { requireConclaveAccess } from "../middleware/conclaveAccess.js";
import { asyncHandler } from "../middleware/errors.js";
import * as c from "../controllers/admin.controller.js";

const router = Router();

/**
 * The entire admin surface is guarded here, in ONE place, so a new route cannot
 * be added unprotected by accident. Every handler below can assume req.uid is a
 * verified administrator.
 */
router.use(requireAdmin);

// Admin-managed settings
router.get("/settings/round-timing", asyncHandler(c.getRoundTiming));
router.put("/settings/round-timing", asyncHandler(c.setRoundTiming));
router.get("/settings/conclave-defaults", asyncHandler(c.getConclaveDefaults));
router.put("/settings/conclave-defaults", asyncHandler(c.setConclaveDefaults));
router.get("/settings/regions", asyncHandler(c.getRegions));
router.put("/settings/regions", asyncHandler(c.setRegions));
router.get("/settings/notifications", asyncHandler(c.getNotificationTemplates));
router.put("/settings/notifications", asyncHandler(c.setNotificationTemplates));

// Business categories (read live by the app from Firestore)
router.get("/categories", asyncHandler(c.listCategories));
router.put("/categories", asyncHandler(c.setCategories)); // replace whole list
router.post("/categories", asyncHandler(c.addCategory)); // { name }
router.post("/categories/remove", asyncHandler(c.removeCategory)); // { name }

// Conclaves. Every /conclaves/:id/... route is region-checked here, once.
router.use("/conclaves/:id", asyncHandler(requireConclaveAccess));
router.get("/conclaves", asyncHandler(c.list));
router.get("/conclaves/:id", asyncHandler(c.getOne));
router.post("/conclaves", asyncHandler(c.create));
router.patch("/conclaves/:id", asyncHandler(c.update));
router.put("/conclaves/:id", asyncHandler(c.update));
router.delete("/conclaves/:id", asyncHandler(c.deleteConclave));

// Lifecycle
router.post("/conclaves/:id/registration", asyncHandler(c.setRegistration));
router.post("/conclaves/:id/cancel", asyncHandler(c.cancel));
router.post("/conclaves/:id/complete", asyncHandler(c.complete));
router.post("/conclaves/:id/lock-schedule", asyncHandler(c.lockSchedule));
router.post("/conclaves/:id/agenda-document", asyncHandler(c.uploadAgendaDocument));
router.post("/conclaves/:id/start-round", asyncHandler(c.startRound));
router.post("/conclaves/:id/pause-round", asyncHandler(c.pauseRound));
router.post("/conclaves/:id/resume-round", asyncHandler(c.resumeRound));
router.post("/conclaves/:id/close-round", asyncHandler(c.closeRound));

// Scheduling
router.post("/conclaves/:id/generate-schedule", asyncHandler(c.generate));

// People
router.get("/conclaves/:id/registrations", asyncHandler(c.registrations));
router.post("/conclaves/:id/registrations/:uid/role", asyncHandler(c.setRole));

// Dashboard
router.get("/conclaves/:id/stats", asyncHandler(c.statistics));
router.get("/conclaves/:id/referrals", asyncHandler(c.referrals));
router.get("/conclaves/:id/attendance", asyncHandler(c.attendance));
router.get("/conclaves/:id/feedback", asyncHandler(c.listConclaveFeedback));

// Payments — per-conclave member payment status (any conclave admin).
router.get("/conclaves/:id/payments", asyncHandler(c.getConclavePayments));

// Revenue — platform-wide, SUPERADMIN only.
// Audit trail — who did what, when, from where (admins and superadmins only).
router.get(
  "/audit",
  requireRole("admin", "superadmin"),
  asyncHandler(async (req, res) => {
    res.json(await queryAudit(req.query));
  }),
);

router.get("/revenue", requireSuperadmin, asyncHandler(c.getRevenue));
router.get("/revenue/transactions", requireSuperadmin, asyncHandler(c.listTransactions));

// Members
router.get("/users/search", asyncHandler(c.findUser));
router.post("/users/:uid/reset-link", asyncHandler(c.resetLink));
router.get("/users", asyncHandler(c.listAllUsers));
router.post("/users/:uid/role", asyncHandler(c.setUserRole));

// Regions and admin accounts: admins and superadmins only (not coordinators).
// Who may manage which account (e.g. only a superadmin creates admins) is
// enforced again inside admins.service — the route gate is the first line.
const manageAccess = requireRole("admin", "superadmin");

router.get("/regions", asyncHandler(c.listRegions));
router.post("/regions", manageAccess, asyncHandler(c.createRegion));
router.patch("/regions/:id", manageAccess, asyncHandler(c.updateRegion));
router.delete("/regions/:id", manageAccess, asyncHandler(c.deleteRegion));

router.get("/coordinators", manageAccess, asyncHandler(c.listCoordinators));
router.post("/coordinators", manageAccess, asyncHandler(c.createCoordinator));
router.patch("/coordinators/:uid", manageAccess, asyncHandler(c.updateCoordinator));
router.post("/coordinators/:uid/reset-password", manageAccess, asyncHandler(c.resetCoordinatorPassword));
router.delete("/coordinators/:uid", manageAccess, asyncHandler(c.deleteCoordinator));

export default router;
