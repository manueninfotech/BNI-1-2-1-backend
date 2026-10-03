import fs from "fs";
import path from "path";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, auth, collections } from "../config/firebase.js";
import * as conclaves from "../services/conclave.service.js";
import { toDate } from "../utils/firestore.js";
import * as schedule from "../services/schedule.service.js";
import * as roles from "../services/role.service.js";
import * as stats from "../services/stats.service.js";
import * as passwordReset from "../services/passwordReset.service.js";
import { fetchUsers } from "../services/user.service.js";
import { uploadBufferToStorage } from "../services/storage.service.js";
import { FieldValue } from "firebase-admin/firestore";
import { ApiError } from "../middleware/errors.js";
import * as categories from "../services/categories.service.js";
import * as settings from "../services/settings.service.js";

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

function isSuperAdmin(admin: Record<string, any> | null, email?: string): boolean {
  if (!admin && !email) return false;
  if (admin?.role === "superadmin") return true;
  const normalizedEmail = (email || admin?.email || "").toLowerCase().trim();
  return normalizedEmail.includes("superadmin");
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
  let regCount = 0;
  let capCount = 0;
  try {
    const [cSnap, capSnap] = await Promise.all([
      doc.ref.collection(collections.registrations).count().get().catch(() => null),
      doc.ref.collection(collections.registrations).where("role", "==", "captain").count().get().catch(() => null),
    ]);
    if (cSnap) regCount = cSnap.data().count;
    if (capSnap) capCount = capSnap.data().count;
  } catch {}

  if (capCount === 0) {
    try {
      const [capSnapUpper, capSnapBool] = await Promise.all([
        doc.ref.collection(collections.registrations).where("role", "==", "Captain").count().get().catch(() => null),
        doc.ref.collection(collections.registrations).where("isTableCaptain", "==", true).count().get().catch(() => null),
      ]);
      if (capSnapUpper && capSnapUpper.data().count > 0) capCount = capSnapUpper.data().count;
      else if (capSnapBool && capSnapBool.data().count > 0) capCount = capSnapBool.data().count;
    } catch {}
  }

  const memberCount = regCount || (Array.isArray(d.participants) ? d.participants.length : 0);
  const countFromParticipantsCaptains = Array.isArray(d.participants)
    ? d.participants.filter((p: any) => p.role === "captain" || p.role === "Captain" || p.isCaptain || p.isTableCaptain).length
    : 0;
  const countFromSchedule = Array.isArray(d.schedule?.rounds?.[0]?.tables)
    ? new Set(d.schedule.rounds[0].tables.map((t: any) => t.captainId).filter(Boolean)).size
    : 0;
  const captainCount = capCount > 0 ? capCount : (Number(d.captainCount) > 0 ? Number(d.captainCount) : (countFromParticipantsCaptains > 0 ? countFromParticipantsCaptains : countFromSchedule));

  res.json({
    id: doc.id,
    ...d,
    memberCount,
    membersCount: memberCount,
    registrationCount: memberCount,
    captainCount,
    captainsCount: captainCount,
    date: toDate(d.date)?.toISOString() ?? null,
    startDate: toDate(d.startDate || d.date)?.toISOString() ?? null,
    endDate: toDate(d.endDate)?.toISOString() ?? null,
    regStartDate: toDate(d.regStartDate)?.toISOString() ?? null,
    regEndDate: toDate(d.regEndDate)?.toISOString() ?? null,
    startTime: conclaves.normalizeTime(d.startTime),
    endTime: conclaves.normalizeTime(d.endTime),
    currentRoundStartedAt: toDate(d.currentRoundStartedAt)?.toISOString() ?? null,
  });
}


export async function create(req: AuthedRequest, res: Response) {
  const admin = await getAdminDoc(req.uid);
  // Auto-assign the creating admin's region to the conclave.
  // Superadmin/Global can override by passing region explicitly in the body.
  const body = req.body ?? {};
  if (!body.region && admin?.region && admin.region !== "Global") {
    body.region = admin.region;
  }
  const conclaveId = await conclaves.createConclave(body);
  res.status(201).json({
    message: "Conclave created. Registration is closed until you open it.",
    conclaveId,
  });
}

export async function update(req: AuthedRequest, res: Response) {
  const updated = await conclaves.updateConclave(req.params.id, req.body ?? {});
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

export async function getConclavePermissions(req: AuthedRequest, res: Response) {
  const { data } = await conclaves.getConclaveOrThrow(req.params.id);
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuper = isSuperAdmin(admin, req.email);
  const isLocked = Boolean(data.isScheduleLocked || data.status === "locked");
  const evalResult = conclaves.evaluateConclaveStatus(data);
  res.json({
    conclaveId: req.params.id,
    allowAdminAddMembers: Boolean(data.allowAdminAddMembers),
    isSuperAdmin: isSuper,
    isScheduleLocked: isLocked,
    isRegistrationOpen: !isLocked && evalResult.isRegistrationOpen,
    canAddMembers: !isLocked && (isSuper || Boolean(data.allowAdminAddMembers)),
  });
}

export async function setConclavePermissions(req: AuthedRequest, res: Response) {
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuper = isSuperAdmin(admin, req.email);
  if (!isSuper) {
    throw ApiError.forbidden("Only superadmin can configure member addition permissions for conclaves.");
  }
  const { allowAdminAddMembers } = req.body ?? {};
  if (typeof allowAdminAddMembers !== "boolean") {
    throw ApiError.badRequest("Body must be { allowAdminAddMembers: boolean }.");
  }
  const { ref, data } = await conclaves.getConclaveOrThrow(req.params.id);
  if (data.isScheduleLocked || data.status === "locked") {
    throw ApiError.conflict("Cannot modify member permissions because this conclave schedule is generated and locked.");
  }
  await ref.update({
    allowAdminAddMembers,
    updatedAt: new Date(),
  });
  conclaves.clearConclaveCache();
  res.json({
    message: allowAdminAddMembers
      ? "Permission granted: Admins can now add members to this conclave."
      : "Permission revoked: Admins can no longer add members to this conclave.",
    conclaveId: req.params.id,
    allowAdminAddMembers,
  });
}

export async function addMemberToConclave(req: AuthedRequest, res: Response) {
  const conclaveId = req.params.id;
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuper = isSuperAdmin(admin, req.email);
  const { data: conclave, ref: conclaveDocRef } = await conclaves.getConclaveOrThrow(conclaveId);

  // If schedule is generated and locked, even admin cannot add members to that conclave
  if (conclave.isScheduleLocked || conclave.status === "locked") {
    throw ApiError.conflict("Cannot add members to this conclave because the schedule is generated and locked.");
  }

  if (conclave.status === "completed" || conclave.status === "cancelled" || conclave.status === "running") {
    throw ApiError.conflict(`Cannot add members to a conclave that is ${conclave.status}.`);
  }

  // Superadmin has full permission. Regular admin requires allowAdminAddMembers to be true.
  if (!isSuper && !conclave.allowAdminAddMembers) {
    throw ApiError.forbidden(
      "Admins do not have permission to add members to this conclave. Permission must be granted by Superadmin."
    );
  }

  const body = req.body || {};
  let targetUid = String(body.userId || body.uid || "").trim();
  let userData: Record<string, any> = {};

  if (targetUid) {
    const uDoc = await db.collection(collections.users).doc(targetUid).get();
    if (uDoc.exists) {
      userData = uDoc.data() || {};
    }
  } else {
    const email = String(body.email || "").toLowerCase().trim();
    const phone = String(body.phone || body.mobile || "").trim();

    if (!email && !phone && !body.name) {
      throw ApiError.badRequest("Please provide either userId or member details (name, email, or phone).");
    }

    if (email) {
      const snap = await db.collection(collections.users).where("email", "==", email).limit(1).get();
      if (!snap.empty) {
        targetUid = snap.docs[0].id;
        userData = snap.docs[0].data();
      }
    }

    if (!targetUid && phone) {
      const snap = await db.collection(collections.users).where("phone", "==", phone).limit(1).get();
      if (!snap.empty) {
        targetUid = snap.docs[0].id;
        userData = snap.docs[0].data();
      }
    }

    // If member not found in users collection, create a user record
    if (!targetUid) {
      targetUid = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newUserDoc = {
        name: body.name || "BNI Member",
        email: email || "",
        phone: phone || "",
        company: body.company || body.businessName || "",
        category: body.category || body.businessCategory || "",
        chapter: body.chapter || "",
        region: body.region || conclave.region || "Global",
        state: body.state || "",
        country: body.country || "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection(collections.users).doc(targetUid).set(newUserDoc);
      userData = newUserDoc;
    }
  }

  // Capacity check
  try {
    const regCountSnap = await conclaveDocRef.collection(collections.registrations).count().get();
    const currentCount = regCountSnap.data().count;
    if (conclave.memberLimit && currentCount >= conclave.memberLimit && !isSuper) {
      throw ApiError.conflict(`Conclave capacity limit reached (${conclave.memberLimit} members).`);
    }
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
  }

  const regRef = conclaveDocRef.collection(collections.registrations).doc(targetUid);
  const existingReg = await regRef.get();
  if (existingReg.exists) {
    throw ApiError.conflict("This member is already registered for this conclave.");
  }

  const role = body.role === "captain" ? "captain" : "member";
  const name = body.name || userData.name || "BNI Member";
  const email = (body.email || userData.email || "").toLowerCase().trim();
  const phone = body.phone || body.mobile || userData.phone || userData.mobile || "";
  const company = body.company || body.businessName || userData.company || userData.businessName || "";
  const category = body.category || body.businessCategory || userData.category || userData.businessCategory || "";
  const chapter = body.chapter || userData.chapter || "";
  const region = body.region || userData.region || conclave.region || "";
  const state = body.state || userData.state || conclave.state || "";
  const country = body.country || userData.country || conclave.country || "";

  const regData: Record<string, any> = {
    userId: targetUid,
    name,
    email,
    phone,
    company,
    category,
    chapter,
    region,
    state,
    country,
    role,
    status: "confirmed",
    registeredAt: new Date(),
    addedBy: {
      uid: req.uid,
      email: req.email || admin?.email || "",
      role: isSuper ? "superadmin" : "admin",
      addedAt: new Date(),
    },
    payment: {
      method: body.paymentMethod || "admin_direct",
      status: "paid",
      amount: conclave.registrationFee || 0,
      currency: "INR",
      paidAt: new Date(),
    },
  };

  await regRef.set(regData);

  // Sync to user profile conclaveIds
  await db.collection(collections.users).doc(targetUid).set({
    conclaveIds: FieldValue.arrayUnion(conclaveId),
    updatedAt: new Date(),
  }, { merge: true }).catch(() => {});

  conclaves.clearConclaveCache();

  res.status(201).json({
    message: `Member ${name} added successfully to ${conclave.name}.`,
    registration: regData,
  });
}

export async function updateMemberInConclave(req: AuthedRequest, res: Response) {
  const conclaveId = req.params.id;
  const memberUid = req.params.uid;
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuper = isSuperAdmin(admin, req.email);
  const { data: conclave, ref: conclaveDocRef } = await conclaves.getConclaveOrThrow(conclaveId);

  // Superadmin has full permission. Regular admin requires allowAdminAddMembers to be true.
  if (!isSuper && !conclave.allowAdminAddMembers) {
    throw ApiError.forbidden(
      "Admins do not have permission to edit members in this conclave. Permission must be granted by Superadmin."
    );
  }

  const regRef = conclaveDocRef.collection(collections.registrations).doc(memberUid);
  const regSnap = await regRef.get();
  if (!regSnap.exists) {
    throw ApiError.notFound("Registration not found for this member in this conclave.");
  }

  const body = req.body || {};

  if ((conclave.isScheduleLocked || conclave.status === "locked") && body.role !== undefined && body.role !== regSnap.data()?.role) {
    throw ApiError.conflict("Cannot change member role because the schedule is generated and locked.");
  }
  const updates: Record<string, any> = {
    updatedAt: new Date(),
  };

  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.email !== undefined) updates.email = String(body.email).toLowerCase().trim();
  if (body.phone !== undefined || body.mobile !== undefined) updates.phone = String(body.phone || body.mobile).trim();
  if (body.company !== undefined || body.businessName !== undefined) updates.company = String(body.company || body.businessName).trim();
  if (body.category !== undefined || body.businessCategory !== undefined) updates.category = String(body.category || body.businessCategory).trim();
  if (body.chapter !== undefined) updates.chapter = String(body.chapter).trim();
  if (body.region !== undefined) updates.region = String(body.region).trim();
  if (body.state !== undefined) updates.state = String(body.state).trim();
  if (body.country !== undefined) updates.country = String(body.country).trim();
  if (body.role !== undefined) updates.role = body.role === "captain" ? "captain" : "member";
  if (body.status !== undefined) updates.status = body.status;

  await regRef.set(updates, { merge: true });

  // Sync to users collection doc
  const userUpdates: Record<string, any> = {
    updatedAt: new Date(),
  };
  if (updates.name) userUpdates.name = updates.name;
  if (updates.email) userUpdates.email = updates.email;
  if (updates.phone) userUpdates.phone = updates.phone;
  if (updates.company) userUpdates.company = updates.company;
  if (updates.category) userUpdates.category = updates.category;
  if (updates.chapter) userUpdates.chapter = updates.chapter;
  if (updates.region) userUpdates.region = updates.region;
  if (updates.state) userUpdates.state = updates.state;
  if (updates.country) userUpdates.country = updates.country;

  await db.collection(collections.users).doc(memberUid).set(userUpdates, { merge: true }).catch(() => {});

  conclaves.clearConclaveCache();

  res.json({
    message: "Member registration updated successfully.",
    member: {
      userId: memberUid,
      ...regSnap.data(),
      ...updates,
    },
  });
}

export async function removeMemberFromConclave(req: AuthedRequest, res: Response) {
  const conclaveId = req.params.id;
  const memberUid = req.params.uid;
  const admin = await getAdminDoc(req.uid, req.email);
  const isSuper = isSuperAdmin(admin, req.email);
  const { data: conclave, ref: conclaveDocRef } = await conclaves.getConclaveOrThrow(conclaveId);

  if (!isSuper && !conclave.allowAdminAddMembers) {
    throw ApiError.forbidden(
      "Admins do not have permission to manage members for this conclave. Permission must be granted by Superadmin."
    );
  }

  if (conclave.isScheduleLocked || conclave.status === "locked") {
    throw ApiError.conflict("Cannot remove members from this conclave because the schedule is generated and locked.");
  }

  const regRef = conclaveDocRef.collection(collections.registrations).doc(memberUid);
  const regSnap = await regRef.get();
  if (!regSnap.exists) {
    throw ApiError.notFound("Registration not found for this member in this conclave.");
  }

  await regRef.delete();

  await db.collection(collections.users).doc(memberUid).set({
    conclaveIds: FieldValue.arrayRemove(conclaveId),
    updatedAt: new Date(),
  }, { merge: true }).catch(() => {});

  conclaves.clearConclaveCache();

  res.json({ message: "Member removed from conclave successfully." });
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
      status: data.status || "Connected",
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

  // Normalize helper
  const normKey = (str: string) => String(str || "").toLowerCase().replace(/\s+region$/, "").trim();

  // Map of normalized region name -> conclaves count
  const conclaveCounts: Record<string, number> = {};
  conclavesSnap.docs.forEach(doc => {
    const data = doc.data();
    const reg = normKey(data.region || "Global");
    conclaveCounts[reg] = (conclaveCounts[reg] || 0) + 1;
  });

  // Map of normalized region name -> members count
  const memberCounts: Record<string, number> = {};
  usersSnap.docs.forEach(doc => {
    const data = doc.data();
    const loc = data.location;
    const reg = normKey(data.region || (loc ? (typeof loc === "object" ? loc.place : loc) : undefined) || "Global");
    memberCounts[reg] = (memberCounts[reg] || 0) + 1;
  });

  // Attach counts to regions list (matching with normalization)
  const list = regionsList.map(r => {
    const k = normKey(r.name);
    return {
      ...r,
      name: r.name ? r.name.trim() : r.name,
      conclavesCount: conclaveCounts[k] || 0,
      membersCount: memberCounts[k] || 0
    };
  });

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
    role: role || "coordinator",
    grantedAt: new Date()
  });
  res.status(201).json({ uid, message: "Coordinator created successfully." });
}

export async function updateCoordinator(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
  const { name, mobile, region, status, role } = req.body ?? {};
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
  if (!password) {
    return res.status(400).json({ error: "Password is required." });
  }
  await auth.updateUser(uid, { password });
  res.json({ message: "Password reset successfully." });
}

export async function deleteCoordinator(req: AuthedRequest, res: Response) {
  const { uid } = req.params;
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



