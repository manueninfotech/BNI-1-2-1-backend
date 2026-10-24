import fs from "fs";
import { assertRegion, regionScope } from "../middleware/conclaveAccess.js";
import * as adminsService from "../services/admins.service.js";
import * as usersService from "../services/user.service.js";
import * as regionsService from "../services/regions.service.js";
import path from "path";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, collections } from "../config/firebase.js";
import * as conclaves from "../services/conclave.service.js";
import { toDate } from "../utils/firestore.js";
import * as schedule from "../services/schedule.service.js";
import * as roles from "../services/role.service.js";
import * as stats from "../services/stats.service.js";
import * as passwordReset from "../services/passwordReset.service.js";
import { fetchUsers } from "../services/user.service.js";
import { uploadBufferToStorage } from "../services/storage.service.js";
import * as categories from "../services/categories.service.js";
import * as settings from "../services/settings.service.js";
import * as feedback from "../services/feedback.service.js";
import * as payments from "../services/payments.service.js";

// --- Payments / revenue ------------------------------------------------------

/** Superadmin: platform-wide revenue — totals, per-conclave, time series. */
export async function getRevenue(_req: AuthedRequest, res: Response) {
  res.json(await payments.getRevenue());
}

/** Superadmin: the most recent payments across all conclaves. */
export async function listTransactions(req: AuthedRequest, res: Response) {
  const limit = Math.min(200, Math.max(1, Number((req as any).query?.limit) || 50));
  res.json(await payments.listTransactions(limit));
}

/** Conclave admin: each member's payment status + failed attempts, for one conclave. */
export async function getConclavePayments(req: AuthedRequest, res: Response) {
  res.json(await payments.getConclavePayments(req.params.id));
}

export async function listConclaveFeedback(req: AuthedRequest, res: Response) {
  res.json(await feedback.listFeedback(req.params.id));
}

// ---- Admin-managed settings (round timing, defaults, regions, notifs) -----
export async function getRoundTiming(_req: AuthedRequest, res: Response) {
  res.json(await settings.getRoundTiming());
}
export async function setRoundTiming(req: AuthedRequest, res: Response) {
  res.json(await settings.setRoundTiming(req.body || {}));
}
export async function getConclaveDefaults(_req: AuthedRequest, res: Response) {
  res.json(await settings.getConclaveDefaults());
}
export async function setConclaveDefaults(req: AuthedRequest, res: Response) {
  res.json(await settings.setConclaveDefaults(req.body || {}));
}
export async function getRegions(_req: AuthedRequest, res: Response) {
  res.json({ regions: await settings.getRegions() });
}
export async function setRegions(req: AuthedRequest, res: Response) {
  res.json({ regions: await settings.setRegions(req.body?.regions) });
}
export async function getNotificationTemplates(_req: AuthedRequest, res: Response) {
  res.json(await settings.getNotificationTemplates());
}
export async function setNotificationTemplates(req: AuthedRequest, res: Response) {
  res.json(await settings.setNotificationTemplates(req.body || {}));
}

// ---- Business categories (managed here, read live by the app) -------------
export async function listCategories(_req: AuthedRequest, res: Response) {
  res.json({ categories: await categories.listCategories() });
}
export async function setCategories(req: AuthedRequest, res: Response) {
  res.json({ categories: await categories.setCategories(req.body?.categories) });
}
export async function addCategory(req: AuthedRequest, res: Response) {
  res.json({ categories: await categories.addCategory(req.body?.name) });
}
export async function removeCategory(req: AuthedRequest, res: Response) {
  res.json({ categories: await categories.removeCategory(req.body?.name) });
}



export async function list(req: AuthedRequest, res: Response) {
  // Superadmins and Global-region admins see every conclave; everyone else only
  // their region. (?global=true no longer widens a regional admin's view.)
  const scope = regionScope(req.admin);
  if (scope === "__none__") return res.json([]);
  res.json(await conclaves.listConclaves(scope ?? undefined));
}

export async function getOne(req: AuthedRequest, res: Response) {
  const { data } = await conclaves.getConclaveOrThrow(req.params.id);
  res.json(data);
}

export async function create(req: AuthedRequest, res: Response) {
  const body = { ...(req.body ?? {}) };
  const scope = regionScope(req.admin);
  if (scope !== null) {
    // Regional admins create only in their own region.
    assertRegion(req.admin, body.region ?? scope);
    body.region = scope;
  }
  const conclaveId = await conclaves.createConclave(body);
  res.status(201).json({ message: "Conclave created. Registration is closed until you open it.", conclaveId });
}

export async function update(req: AuthedRequest, res: Response) {
  const body = { ...(req.body ?? {}) };
  // The route guard already checked the conclave is in the caller's region;
  // a regional admin also can't move it out.
  if (regionScope(req.admin) !== null && body.region !== undefined) assertRegion(req.admin, body.region);
  const updated = await conclaves.updateConclave(req.params.id, body);
  res.json({ message: "Conclave updated.", updated });
}

export async function setRegistration(req: AuthedRequest, res: Response) {
  const { open } = req.body ?? {};
  if (typeof open !== "boolean") {
    return res.status(400).json({ error: "Body must be { open: true | false }." });
  }
  await conclaves.setRegistrationOpen(req.params.id, open);
  res.json({ message: open ? "Registration opened." : "Registration closed." });
}

export async function cancel(req: AuthedRequest, res: Response) {
  await conclaves.cancelConclave(req.params.id);
  res.json({ message: "Conclave cancelled." });
}

export async function lockSchedule(req: AuthedRequest, res: Response) {
  await conclaves.lockConclaveSchedule(req.params.id);
  res.json({ message: "Schedule locked and published successfully." });
}

export async function uploadAgendaDocument(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  const agendaDoc = req.body?.agendaDocument;

  if (!agendaDoc) {
    const ref = conclaves.conclaveRef(id);
    await ref.set({
      agendaDocument: null,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return res.json({ message: "Agenda document cleared.", agendaDocument: null });
  }

  let fileUrl = agendaDoc.dataUrl || agendaDoc.url || "";
  let savedFileName = agendaDoc.name || "agenda.pdf";
  // Object path in Firebase Storage — kept so the file can be deleted later.
  let storagePath = "";

  // Upload to Firebase Storage when a base64 data URL is provided.
  if (agendaDoc.dataUrl && agendaDoc.dataUrl.startsWith("data:")) {
    try {
      // data:<contentType>;base64,<data>
      const match = agendaDoc.dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
      const contentType = match?.[1] || agendaDoc.type || "application/pdf";
      const base64Data = match?.[2] ?? agendaDoc.dataUrl.split(";base64,")[1] ?? "";
      const buffer = Buffer.from(base64Data, "base64");

      const result = await uploadBufferToStorage(buffer, savedFileName, contentType, "agendas");
      if (result) {
        fileUrl = result.url;
        storagePath = result.path;
        console.log(`[Storage] Uploaded agenda to Firebase Storage: ${result.path}`);
      } else {
        // Fallback to local disk if Storage is unreachable.
        const uploadsDir = path.join(process.cwd(), "uploads", "agendas");
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const cleanName = savedFileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const fileNameOnDisk = `${id}_${Date.now()}_${cleanName}`;
        fs.writeFileSync(path.join(uploadsDir, fileNameOnDisk), buffer);
        fileUrl = `/uploads/agendas/${fileNameOnDisk}`;
      }
    } catch (err: any) {
      console.error("Failed to process agenda document upload:", err);
    }
  }

  const finalDocRecord = {
    name: savedFileName,
    url: fileUrl,
    dataUrl: fileUrl,
    // Storage object path (was Cloudinary public_id). `publicId` kept as an alias
    // so any existing admin-panel code reading that field still works.
    storagePath,
    publicId: storagePath,
    rawText: agendaDoc.rawText || agendaDoc.agendaText || "",
    agendaText: agendaDoc.agendaText || agendaDoc.rawText || "",
    type: agendaDoc.type || "application/pdf",
    size: agendaDoc.size || "1.0 MB",
    uploadedAt: new Date().toISOString()
  };

  const ref = conclaves.conclaveRef(id);
  await ref.set({
    agendaDocument: finalDocRecord,
    updatedAt: new Date().toISOString()
  }, { merge: true });

  res.json({ message: "Agenda document uploaded and saved to server successfully.", agendaDocument: finalDocRecord });
}


export async function complete(req: AuthedRequest, res: Response) {
  const result = await conclaves.completeConclave(req.params.id);
  res.json({
    message: "Conclave completed. Members can now see their summaries.",
    ...result,
  });
}

export async function startRound(req: AuthedRequest, res: Response) {
  const roundNumber = Number(req.body?.roundNumber);
  const startedAt = await conclaves.startRound(req.params.id, roundNumber, req.uid);
  res.json({
    message: `Round ${roundNumber} started.`,
    roundStartedAt: startedAt.toISOString(),
  });
}

export async function pauseRound(req: AuthedRequest, res: Response) {
  const result = await conclaves.pauseRound(req.params.id);
  res.json({
    message: "Round timer paused.",
    ...result,
  });
}

export async function resumeRound(req: AuthedRequest, res: Response) {
  const result = await conclaves.resumeRound(req.params.id);
  res.json({
    message: "Round timer resumed.",
    ...result,
  });
}

export async function closeRound(req: AuthedRequest, res: Response) {
  const result = await conclaves.closeRound(req.params.id);
  res.json({
    message: "Round concluded.",
    ...result,
  });
}

export async function generate(req: AuthedRequest, res: Response) {
  const result = await schedule.generateForConclave(req.params.id, {
    activeOnly: req.body?.activeOnly === true,
    autoFillCaptains: req.body?.autoFillCaptains === true,
    personsPerTable: req.body?.personsPerTable !== undefined ? Number(req.body.personsPerTable) : undefined,
    roundCount: req.body?.roundCount !== undefined ? Number(req.body.roundCount) : undefined,
  });
  res.json({ message: "Schedule generated successfully.", ...result });
}

export async function registrations(req: AuthedRequest, res: Response) {
  res.json(await stats.registrationsWithCounts(req.params.id));
}

export async function setRole(req: AuthedRequest, res: Response) {
  const { id, uid } = req.params;
  const role = req.body?.role as roles.Role;
  await roles.setRole(id, uid, role);
  res.json({ message: `Role set to ${role}.`, uid, role });
}

export async function statistics(req: AuthedRequest, res: Response) {
  res.json(await stats.conclaveStats(req.params.id));
}

/**
 * A one-time password reset link for a member.
 *
 * Needed because a phone account's sign-in address is synthetic and receives no
 * mail, so the self-serve "email me a link" flow cannot work for them. The link
 * is returned to the admin to pass on; the member sets their own password, so
 * the admin never learns it.
 */
export async function resetLink(req: AuthedRequest, res: Response) {
  const result = await passwordReset.generateResetLink(req.params.uid);
  res.json({
    message: "Send this link to the member. It can only be used once.",
    ...result,
  });
}

/** Find a member by email or phone. Admin-only: public, this enumerates members. */
export async function findUser(req: AuthedRequest, res: Response) {
  const q = (req.query.q as string) ?? "";
  res.json({ results: await passwordReset.findUser(q) });
}

export async function referrals(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  const ref = conclaves.conclaveRef(id);
  const snap = await ref.collection(collections.referrals).get();

  const cDoc = await ref.get();
  const cData = cDoc.data() || {};
  const participants = Array.isArray(cData.participants) ? cData.participants : [];

  const usersMap = new Map<string, { name: string; businessCategory: string }>();

  // 1. Populate from conclave participants
  participants.forEach((p: any) => {
    if (!p) return;
    const info = {
      name: p.name || p.fullName || p.memberName,
      businessCategory: p.businessCategory || p.businessType || p.category || "BNI Member"
    };
    if (info.name && info.name !== "Member" && info.name !== "Unknown Member") {
      if (p.id) usersMap.set(p.id, info);
      if (p.uid) usersMap.set(p.uid, info);
      if (p.userId) usersMap.set(p.userId, info);
      if (p.name) usersMap.set(p.name.toLowerCase().trim(), info);
    }
  });

  // 2. Populate from registrations subcollection
  try {
    const regsSnap = await ref.collection(collections.registrations).get();
    regsSnap.forEach(doc => {
      const data = doc.data();
      const info = {
        name: data.name || data.fullName || data.memberName,
        businessCategory: data.businessCategory || data.businessType || data.category || "BNI Member"
      };
      if (info.name && info.name !== "Member" && info.name !== "Unknown Member") {
        usersMap.set(doc.id, info);
        if (data.uid) usersMap.set(data.uid, info);
        if (data.userId) usersMap.set(data.userId, info);
        if (data.memberId) usersMap.set(data.memberId, info);
        if (data.id) usersMap.set(data.id, info);
        if (data.name) usersMap.set(data.name.toLowerCase().trim(), info);
      }
    });
  } catch {
    // Ignore registrations fetch error
  }

  // 3. Find any unmapped user IDs and fetch directly from root users collection
  const missingUids = new Set<string>();
  snap.docs.forEach(doc => {
    const data = doc.data();
    const fromId = data.fromUserId || data.fromMemberId || data.giverId || data.fromUid;
    const toId = data.toUserId || data.toMemberId || data.receiverId || data.toUid;
    if (fromId && !usersMap.has(fromId)) missingUids.add(fromId);
    if (toId && !usersMap.has(toId)) missingUids.add(toId);
  });

  if (missingUids.size > 0) {
    await Promise.all(
      Array.from(missingUids).map(async (uid) => {
        try {
          const uDoc = await db.collection(collections.users).doc(uid).get();
          if (uDoc.exists) {
            const uData = uDoc.data()!;
            const info = {
              name: uData.name || uData.fullName || uData.memberName || "BNI Member",
              businessCategory: uData.businessCategory || uData.businessType || uData.businessName || "BNI Member"
            };
            usersMap.set(uid, info);
            usersMap.set(uDoc.id, info);
          }
        } catch {
          // Ignore individual user fetch error
        }
      })
    );
  }

  const list = snap.docs.map(doc => {
    const data = doc.data();
    const fromId = data.fromUserId || data.fromMemberId || data.giverId || data.fromUid;
    const toId = data.toUserId || data.toMemberId || data.receiverId || data.toUid;

    const fromNameFallback = data.fromName || data.giverName || data.fromMemberName || "BNI Member";
    const toNameFallback = data.toName || data.receiverName || data.toMemberName || "BNI Member";

    const fromUser = usersMap.get(fromId) || usersMap.get(fromNameFallback.toLowerCase().trim()) || { name: fromNameFallback, businessCategory: data.fromCategory || "BNI Member" };
    const toUser = usersMap.get(toId) || usersMap.get(toNameFallback.toLowerCase().trim()) || { name: toNameFallback, businessCategory: data.toCategory || "BNI Member" };

    const finalFromName = (fromUser.name && fromUser.name !== "Member" && fromUser.name !== "Unknown Member") ? fromUser.name : (fromNameFallback !== "Member" ? fromNameFallback : "BNI Member");
    const finalToName = (toUser.name && toUser.name !== "Member" && toUser.name !== "Unknown Member") ? toUser.name : (toNameFallback !== "Member" ? toNameFallback : "BNI Member");

    return {
      id: doc.id,
      conclaveId: id,
      fromMemberId: fromId || doc.id,
      fromName: finalFromName,
      fromCategory: fromUser.businessCategory,
      toMemberId: toId || doc.id,
      toName: finalToName,
      toCategory: toUser.businessCategory,
      roundNumber: data.roundNumber || 1,
      notes: data.notes || data.description || "",
      status: data.status || "Pending",
      createdAt: data.createdAt ? toDate(data.createdAt)?.toISOString() : null
    };
  });

  res.json(list);
}

export async function attendance(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  const snap = await db
    .collection(collections.conclaves)
    .doc(id)
    .collection(collections.attendance)
    .get();

  const userIds = [...new Set(snap.docs.map(d => d.data().userId).filter(Boolean))];
  const users = await fetchUsers(userIds);

  const list = snap.docs.map(doc => {
    const data = doc.data();
    const user = users.get(data.userId);
    return {
      id: doc.id,
      userId: data.userId,
      userName: user?.name || data.name || "Member",
      userCategory: user?.category || "BNI Member",
      roundNumber: data.roundNumber || 1,
      tableNumber: data.tableNumber || null,
      isPresent: !!data.isPresent,
      source: data.source || "self",
      markedBy: data.markedBy || data.userId,
      markedAt: data.markedAt ? toDate(data.markedAt)?.toISOString() : null,
    };
  });

  res.json(list);
}

// ---- Superadmin Regions CRUD ----------------------------------------------

export async function listRegions(_req: AuthedRequest, res: Response) {
  res.json(await regionsService.listRegions());
}

export async function createRegion(req: AuthedRequest, res: Response) {
  const { id } = await regionsService.createRegion(req.body ?? {});
  res.status(201).json({ id, message: "Region created successfully." });
}

export async function updateRegion(req: AuthedRequest, res: Response) {
  await regionsService.updateRegion(req.params.id, req.body ?? {});
  res.json({ message: "Region updated successfully." });
}

export async function deleteRegion(req: AuthedRequest, res: Response) {
  await regionsService.deleteRegion(req.params.id);
  res.json({ message: "Region deleted successfully." });
}

// ---- Superadmin Coordinators CRUD -----------------------------------------

export async function listCoordinators(req: AuthedRequest, res: Response) {
  res.json(await adminsService.listAdmins(req.admin!));
}

export async function createCoordinator(req: AuthedRequest, res: Response) {
  const { uid } = await adminsService.createAdmin(req.admin!, req.body ?? {});
  res.status(201).json({ uid, message: "Coordinator created successfully." });
}

export async function updateCoordinator(req: AuthedRequest, res: Response) {
  await adminsService.updateAdmin(req.admin!, req.params.uid, req.body ?? {});
  res.json({ message: "Coordinator updated successfully." });
}

export async function resetCoordinatorPassword(req: AuthedRequest, res: Response) {
  await adminsService.resetAdminPassword(req.admin!, req.params.uid, req.body?.password);
  res.json({ message: "Password reset successfully." });
}

export async function deleteCoordinator(req: AuthedRequest, res: Response) {
  await adminsService.deleteAdmin(req.admin!, req.params.uid);
  res.json({ message: "Coordinator access revoked successfully." });
}

export async function listAllUsers(_req: AuthedRequest, res: Response) {
  res.json(await usersService.listAllMembersForAdmin());
}

export async function deleteConclave(req: AuthedRequest, res: Response) {
  await conclaves.deleteConclave(req.params.id);
  res.json({ message: "Conclave deleted successfully." });
}

export async function setUserRole(req: AuthedRequest, res: Response) {
  await usersService.setUserRole(req.params.uid, req.body?.role);
  res.json({ message: "User role updated successfully." });
}

