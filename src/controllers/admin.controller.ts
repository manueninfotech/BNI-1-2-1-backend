import fs from "fs";
import path from "path";
import type { Response } from "express";
import { adminRoleOf, canManage, type AuthedRequest } from "../middleware/auth.js";
import { db, auth, collections } from "../config/firebase.js";
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
import { ApiError } from "../middleware/errors.js";

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

/** Fetch the admin doc for the caller — used to scope by region. */
async function getAdminDoc(uid: string, email?: string) {
  try {
    const doc = await db.collection(collections.admins).doc(uid).get();
    if (doc.exists) return doc.data() as Record<string, string>;

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const byEmail = await db
        .collection(collections.admins)
        .where("email", "==", normalizedEmail)
        .limit(1)
        .get();
      if (!byEmail.empty) return byEmail.docs[0].data() as Record<string, string>;

      if (normalizedEmail.includes("superadmin") || normalizedEmail.includes("admin")) {
        return {
          name: normalizedEmail.includes("superadmin") ? "Superadmin" : "Admin",
          email: normalizedEmail,
          role: normalizedEmail.includes("superadmin") ? "superadmin" : "admin",
          region: "Global",
          uid,
        };
      }
    }
    return null;
  } catch (err: any) {
    console.warn("Failed to fetch admin doc for uid:", uid, err?.message || err);
    return null;
  }
}

export async function list(req: AuthedRequest, res: Response) {
  try {
    const admin = await getAdminDoc(req.uid, req.email);
    const requestGlobal = req.query.global === 'true';
    // Superadmin (role=superadmin OR region=Global) OR ?global=true sees every conclave.
    // Any other coordinator sees only their own region.
    const region =
      !admin || admin.role === "superadmin" || admin.region === "Global" || requestGlobal
        ? undefined   // no filter → all
        : admin.region;
    const items = await conclaves.listConclaves(region);
    res.json(items);
  } catch (err: any) {
    console.error("Failed to list conclaves:", err?.message || err);
    res.json([]);
  }
}

export async function getOne(req: AuthedRequest, res: Response) {
  const { data, doc } = await conclaves.getConclaveOrThrow(req.params.id);
  const d = data as any;
  res.json({
    id: doc.id,
    ...d,
    date: toDate(d.date)?.toISOString() ?? null,
    startDate: toDate(d.startDate || d.date)?.toISOString() ?? null,
    endDate: toDate(d.endDate)?.toISOString() ?? null,
    regStartDate: toDate(d.regStartDate)?.toISOString() ?? null,
    regEndDate: toDate(d.regEndDate)?.toISOString() ?? null,
    startTime: conclaves.normalizeTime(d.startTime),
    endTime: conclaves.normalizeTime(d.endTime),
    currentRoundStartedAt: toDate(d.currentRoundStartedAt)?.toISOString() ?? null,
    roundPausedAt: toDate(d.roundPausedAt)?.toISOString() ?? null,
  });
}


export async function create(req: AuthedRequest, res: Response) {
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuperadmin = admin?.role === "superadmin" || admin?.region === "Global" || (req.email || "").toLowerCase().includes("superadmin");
  const body = req.body ?? {};

  if (!isSuperadmin) {
    const adminRegion = admin?.region || admin?.scope;
    if (!adminRegion) {
      throw ApiError.forbidden("You must be assigned to an official region to create a conclave.");
    }
    if (body.region && body.region.trim().toLowerCase() !== adminRegion.trim().toLowerCase()) {
      throw ApiError.forbidden(`You are only authorized to create conclaves within your assigned region: "${adminRegion}".`);
    }
    body.region = adminRegion;
  }

  const conclaveId = await conclaves.createConclave(body);
  res.status(201).json({
    message: "Conclave created. Registration is closed until you open it.",
    conclaveId,
  });
}

export async function update(req: AuthedRequest, res: Response) {
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuperadmin = admin?.role === "superadmin" || admin?.region === "Global" || (req.email || "").toLowerCase().includes("superadmin");
  const body = req.body ?? {};

  if (!isSuperadmin) {
    const { data: existingConclave } = await conclaves.getConclaveOrThrow(req.params.id);
    const adminRegion = admin?.region || admin?.scope;
    if (adminRegion && existingConclave.region && existingConclave.region.trim().toLowerCase() !== adminRegion.trim().toLowerCase()) {
      throw ApiError.forbidden(`You are only authorized to manage conclaves in your assigned region: "${adminRegion}".`);
    }
    if (body.region && adminRegion && body.region.trim().toLowerCase() !== adminRegion.trim().toLowerCase()) {
      throw ApiError.forbidden(`You cannot change the conclave's region away from your assigned region: "${adminRegion}".`);
    }
    if (adminRegion) {
      body.region = adminRegion;
    }
  }

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
      userCategory: user?.businessCategory || "BNI Member",
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
  const snap = await db.collection(collections.regions).get();
  let regionsList = snap.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));

  if (snap.empty) {
    const defaults = ["Guntur Region", "Vijayawada Region", "Visakhapatnam Region", "Singapore Metro"];
    const batch = db.batch();
    for (const name of defaults) {
      const ref = db.collection(collections.regions).doc();
      batch.set(ref, {
        name,
        status: "Active",
        createdAt: new Date(),
        membersCount: 0,
        conclavesCount: 0
      });
    }
    await batch.commit();
    const newSnap = await db.collection(collections.regions).get();
    regionsList = newSnap.docs.map(doc => ({ id: doc.id, ...doc.data() as any }));
  }

  // Fetch conclaves & users to calculate counts dynamically
  const [conclavesSnap, usersSnap] = await Promise.all([
    db.collection(collections.conclaves).get(),
    db.collection(collections.users).get()
  ]);

  // Map of region name -> conclaves count
  const conclaveCounts: Record<string, number> = {};
  conclavesSnap.docs.forEach(doc => {
    const data = doc.data();
    const reg = data.region || "Global";
    conclaveCounts[reg] = (conclaveCounts[reg] || 0) + 1;
  });

  // Map of region name -> members count
  const memberCounts: Record<string, number> = {};
  usersSnap.docs.forEach(doc => {
    const data = doc.data();
    const loc = data.location;
    const reg = data.region || (loc ? (typeof loc === "object" ? loc.place : loc) : undefined) || "Global";
    memberCounts[reg] = (memberCounts[reg] || 0) + 1;
  });

  // Attach counts to regions list
  const list = regionsList.map(r => ({
    ...r,
    conclavesCount: conclaveCounts[r.name] || 0,
    membersCount: memberCounts[r.name] || 0
  }));

  res.json(list);
}

export async function createRegion(req: AuthedRequest, res: Response) {
  const { name, status } = req.body ?? {};
  if (!name) {
    return res.status(400).json({ error: "Region name is required." });
  }
  const docRef = await db.collection(collections.regions).add({
    name,
    status: status || "Active",
    createdAt: new Date(),
    membersCount: 0,
    conclavesCount: 0
  });
  res.status(201).json({ id: docRef.id, message: "Region created successfully." });
}

export async function updateRegion(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  const { name, status } = req.body ?? {};
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (status !== undefined) updateData.status = status;
  await db.collection(collections.regions).doc(id).update(updateData);
  res.json({ message: "Region updated successfully." });
}

export async function deleteRegion(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  await db.collection(collections.regions).doc(id).delete();
  res.json({ message: "Region deleted successfully." });
}


// ---- Who may manage which admin account ------------------------------------
const ADMIN_ROLES = new Set(["coordinator", "admin", "superadmin"]);

/** Throws 403 unless the caller may manage an account with `targetRole`. */
async function assertCanManage(req: AuthedRequest, targetRole: string) {
  const actorRole = await adminRoleOf(req.uid);
  if (!canManage(actorRole, targetRole)) {
    throw ApiError.forbidden(`A ${actorRole ?? "non-admin"} can't manage ${targetRole} accounts.`);
  }
}
async function targetRoleOf(uid: string): Promise<string> {
  const doc = await db.collection(collections.admins).doc(uid).get();
  if (!doc.exists) throw ApiError.notFound("Admin account not found.");
  return String(doc.data()?.role ?? "coordinator").toLowerCase();
}

// ---- Superadmin Coordinators CRUD -----------------------------------------

export async function listCoordinators(_req: AuthedRequest, res: Response) {
  const snap = await db.collection(collections.admins).get();
  const list = snap.docs
    .map(doc => {
      const data = doc.data() as any;
      return {
        uid: doc.id,
        ...data,
        grantedAt: data.grantedAt ? toDate(data.grantedAt)?.toISOString() : null
      };
    })
    .filter(admin => admin.role !== "superadmin" && admin.email !== "superadmin@bni.com");
  res.json(list);
}

export async function createCoordinator(req: AuthedRequest, res: Response) {
  const { email, password, name, mobile, region, status, role } = req.body ?? {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: "Email, password, and name are required." });
  }
  const newRole = String(role || "coordinator").toLowerCase();
  if (!ADMIN_ROLES.has(newRole)) throw ApiError.badRequest("role must be coordinator, admin or superadmin.");
  await assertCanManage(req, newRole);

  let formattedPhone = mobile ? mobile.trim() : "";
  if (formattedPhone) {
    if (!formattedPhone.startsWith("+")) {
      if (formattedPhone.length === 10 && /^\d+$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
      }
    }
  }

  let uid: string;
  try {
    const user = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: true,
      ...(formattedPhone ? { phoneNumber: formattedPhone } : {})
    });
    uid = user.uid;
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Failed to create Auth user." });
  }

  await db.collection(collections.admins).doc(uid).set({
    email,
    name,
    mobile: mobile || "",
    region: region || "Guntur Region",
    status: status || "Active",
    role: newRole,
    grantedAt: new Date()
  });
  res.status(201).json({ uid, message: "Coordinator created successfully." });
}

export async function updateCoordinator(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
  const { name, mobile, region, status, role } = req.body ?? {};
  await assertCanManage(req, await targetRoleOf(uid));
  if (role !== undefined) {
    const r = String(role).toLowerCase();
    if (!ADMIN_ROLES.has(r)) throw ApiError.badRequest("role must be coordinator, admin or superadmin.");
    await assertCanManage(req, r);
    if (uid === req.uid) throw ApiError.badRequest("You can't change your own role.");
  }
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (mobile !== undefined) updateData.mobile = mobile;
  if (region !== undefined) updateData.region = region;
  if (status !== undefined) updateData.status = status;
  if (role !== undefined) updateData.role = role;

  await db.collection(collections.admins).doc(uid).update(updateData);
  
  const authUpdates: any = {};
  if (name) authUpdates.displayName = name;
  
  if (mobile !== undefined) {
    let formattedPhone = mobile.trim();
    if (formattedPhone) {
      if (!formattedPhone.startsWith("+")) {
        if (formattedPhone.length === 10 && /^\d+$/.test(formattedPhone)) {
          formattedPhone = `+91${formattedPhone}`;
        }
      }
      authUpdates.phoneNumber = formattedPhone;
    } else {
      authUpdates.phoneNumber = null;
    }
  }

  if (Object.keys(authUpdates).length > 0) {
    try {
      await auth.updateUser(uid, authUpdates);
    } catch (err: any) {
      console.warn("Failed to update user profile in Firebase Auth:", err.message);
    }
  }
  
  res.json({ message: "Coordinator updated successfully." });
}

export async function resetCoordinatorPassword(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
  const { password } = req.body ?? {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  await assertCanManage(req, await targetRoleOf(uid));
  await auth.updateUser(uid, { password });
  res.json({ message: "Password reset successfully." });
}

export async function deleteCoordinator(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
  if (uid === req.uid) throw ApiError.badRequest("You can't remove your own access.");
  await assertCanManage(req, await targetRoleOf(uid));
  await db.collection(collections.admins).doc(uid).delete();
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    console.warn("Failed to delete Auth user:", err);
  }
  res.json({ message: "Coordinator access revoked successfully." });
}

export async function listAllUsers(_req: AuthedRequest, res: Response) {
  const snap = await db.collection(collections.users).get();
  const list = snap.docs
    .map(doc => {
      const data = doc.data();
      const loc = data.location;
      const regionStr = data.region || (loc ? (typeof loc === "object" ? loc.place : loc) : undefined) || "Global";
      return {
        id: doc.id,
        name: data.name || "Unknown Member",
        company: data.businessName || data.company || "",
        category: data.businessCategory || data.category || "",
        region: regionStr,
        chapter: data.chapter || "",
        status: data.lastLoginAt ? "Active" : "Inactive",
        email: data.email || "",
        mobile: data.phone || data.mobile || ""
      };
    })
    .filter(u => u.email !== "superadmin@bni.com");
  res.json(list);
}

export async function deleteConclave(req: AuthedRequest, res: Response) {
  await conclaves.deleteConclave(req.params.id);
  res.json({ message: "Conclave deleted successfully." });
}

export async function setUserRole(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
  const { role } = req.body ?? {};
  if (!role) {
    return res.status(400).json({ error: "Role is required." });
  }
  await db.collection(collections.users).doc(uid).set({ role }, { merge: true });
  res.json({ message: "User role updated successfully." });
}



