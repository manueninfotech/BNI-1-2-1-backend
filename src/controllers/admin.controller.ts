import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, auth, collections } from "../config/firebase.js";
import * as conclaves from "../services/conclave.service.js";
import { toDate } from "../utils/firestore.js";
import * as schedule from "../services/schedule.service.js";
import * as roles from "../services/role.service.js";
import * as stats from "../services/stats.service.js";
import * as passwordReset from "../services/passwordReset.service.js";

/** Fetch the admin doc for the caller — used to scope by region. */
async function getAdminDoc(uid: string) {
  try {
    const doc = await db.collection(collections.admins).doc(uid).get();
    return doc.exists ? (doc.data() as Record<string, string>) : null;
  } catch (err: any) {
    console.warn("Failed to fetch admin doc for uid:", uid, err?.message || err);
    return null;
  }
}

export async function list(req: AuthedRequest, res: Response) {
  try {
    const admin = await getAdminDoc(req.uid);
    // Superadmin (role=superadmin OR region=Global) sees every conclave.
    // Any other coordinator sees only their own region.
    const region =
      !admin || admin.role === "superadmin" || admin.region === "Global"
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
    startTime: toDate(d.startTime)?.toISOString() ?? null,
    endTime: toDate(d.endTime)?.toISOString() ?? null,
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
    const reg = data.region || "Guntur Region";
    conclaveCounts[reg] = (conclaveCounts[reg] || 0) + 1;
  });

  // Map of region name -> members count
  const memberCounts: Record<string, number> = {};
  usersSnap.docs.forEach(doc => {
    const data = doc.data();
    const loc = data.location;
    const reg = loc
      ? (typeof loc === "object" ? (loc.place || "Guntur Region") : loc)
      : "Guntur Region";
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
      const regionStr = loc
        ? (typeof loc === "object" ? (loc.place || "Guntur Region") : loc)
        : "Guntur Region";
      return {
        id: doc.id,
        name: data.name || "Unknown Member",
        company: data.businessName || data.company || "",
        category: data.businessCategory || "",
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
