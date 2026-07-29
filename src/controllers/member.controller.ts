import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, collections } from "../config/firebase.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";
import { listConclaves as listConclaveRecords } from "../services/conclave.service.js";

function toISO(val: any): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return new Date(val).toISOString();
  if (typeof val === 'object') {
    if (typeof val.toDate === 'function') return val.toDate().toISOString();
    if (val._seconds) return new Date(val._seconds * 1000).toISOString();
    if (val.seconds) return new Date(val.seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

export async function me(req: AuthedRequest, res: Response) {
  try {
    const userDoc = await db.collection(collections.users).doc(req.uid).get();
    let data = (userDoc.exists ? userDoc.data() : null) as any;

    // Fallback: if no doc found by UID, search by email or identifier field
    if (!data && req.email) {
      // First try by 'email' field
      const emailSnap = await db.collection(collections.users)
        .where('email', '==', req.email)
        .limit(1)
        .get();
      if (!emailSnap.empty) {
        data = emailSnap.docs[0].data() as any;
      }

      // Also try by 'identifier' field (used as sign-in email for test/synthetic accounts)
      if (!data) {
        const identSnap = await db.collection(collections.users)
          .where('identifier', '==', req.email)
          .limit(1)
          .get();
        if (!identSnap.empty) {
          data = identSnap.docs[0].data() as any;
        }
      }
    }

    if (!data) {
      const adminDoc = await db.collection(collections.admins).doc(req.uid).get();
      if (adminDoc.exists) {
        const adminData = adminDoc.data() as any;
        return res.json({
          uid: req.uid,
          id: req.uid,
          name: adminData.name || "Admin",
          email: adminData.email || "",
          phone: adminData.mobile || "",
          region: adminData.region || "Guntur Region",
          role: adminData.role || "admin",
          createdAt: toISO(adminData.grantedAt || adminData.createdAt),
        });
      }
    }

    res.json({
      uid: req.uid,
      id: req.uid,
      name: data?.name || "Member",
      email: data?.email || req.email || "",
      phone: data?.phone || "",
      company: data?.businessName || "",
      category: data?.businessCategory || "",
      chapter: data?.chapter || "",
      location: data?.location || "",
      createdAt: toISO(data?.createdAt || data?.registeredAt),
      role: data?.role || "member",
    });
  } catch (err: any) {
    res.json({
      uid: req.uid,
      id: req.uid,
      name: "Member",
      email: req.email || "",
      role: "member"
    });
  }
}

export async function updateMe(req: AuthedRequest, res: Response) {
  try {
    const { name, email, phone, mobile, company, businessName, category, businessCategory, chapter, region, designation, organization } = req.body ?? {};

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined || mobile !== undefined) {
      updates.phone = phone ?? mobile;
      updates.mobile = mobile ?? phone;
    }
    if (company !== undefined || businessName !== undefined) {
      updates.company = company ?? businessName;
      updates.businessName = businessName ?? company;
    }
    if (category !== undefined || businessCategory !== undefined) {
      updates.category = category ?? businessCategory;
      updates.businessCategory = businessCategory ?? category;
    }
    if (chapter !== undefined) updates.chapter = chapter;
    if (region !== undefined) updates.region = region;
    if (designation !== undefined) updates.designation = designation;
    if (organization !== undefined) updates.organization = organization;
    updates.updatedAt = new Date().toISOString();

    const userDocRef = db.collection(collections.users).doc(req.uid);
    const userDoc = await userDocRef.get();

    if (userDoc.exists) {
      await userDocRef.set(updates, { merge: true });
    } else {
      const adminDocRef = db.collection(collections.admins).doc(req.uid);
      const adminDoc = await adminDocRef.get();
      if (adminDoc.exists) {
        await adminDocRef.set(updates, { merge: true });
      } else {
        await userDocRef.set(updates, { merge: true });
      }
    }

    res.json({ success: true, message: "Profile updated successfully.", profile: updates });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update profile." });
  }
}

export async function listConclaves(req: AuthedRequest, res: Response) {
  const list = await listConclaveRecords();

  const registeredSet = new Set<string>();
  await Promise.all(
    list.map(async (c: any) => {
      // Primary: look up by Firebase UID (doc ID)
      const regDoc = await db
        .collection(collections.conclaves)
        .doc(c.id)
        .collection(collections.registrations)
        .doc(req.uid)
        .get();
      if (regDoc.exists) {
        registeredSet.add(c.id);
        return;
      }

      // Fallback: search by email or identifier for accounts where UID doesn't match legacy doc ID
      if (req.email) {
        const byEmail = await db
          .collection(collections.conclaves)
          .doc(c.id)
          .collection(collections.registrations)
          .where('email', '==', req.email)
          .limit(1)
          .get();
        if (!byEmail.empty) {
          registeredSet.add(c.id);
          return;
        }

        const byIdentifier = await db
          .collection(collections.conclaves)
          .doc(c.id)
          .collection(collections.registrations)
          .where('identifier', '==', req.email)
          .limit(1)
          .get();
        if (!byIdentifier.empty) {
          registeredSet.add(c.id);
          return;
        }
      }
    }),
  );

  const out = list.map((c: any) => ({
    ...c,
    isRegistered: registeredSet.has(c.id),
  }));

  res.json(out);
}


export async function getReferrals(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  try {
    const snap = await db.collection(collections.conclaves).doc(id).collection(collections.referrals).get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch referrals." });
  }
}

export async function register(req: AuthedRequest, res: Response) {
  const result = await registration.register(req.params.id, req.uid);
  res.json({
    message: result.alreadyRegistered ? "You are already registered." : "Registered.",
    ...result,
  });
}

export async function deregister(req: AuthedRequest, res: Response) {
  const conclaveId = req.params.id;
  const uid = req.uid;

  try {
    await db
      .collection(collections.conclaves)
      .doc(conclaveId)
      .collection(collections.registrations)
      .doc(uid)
      .delete();

    res.json({ message: "Registration cancelled." });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to cancel registration." });
  }
}

export async function syncConclave(req: AuthedRequest, res: Response) {
  const result = await sync.syncConclave(
    req.params.id,
    req.uid, // from the verified token — NEVER from the body
    req.body ?? {},
  );

  res.json(result);
}
