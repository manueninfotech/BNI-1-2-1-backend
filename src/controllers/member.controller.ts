import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, collections } from "../config/firebase.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";
import { listConclaves as listConclaveRecords } from "../services/conclave.service.js";
import { createOrder, razorpayConfigured } from "../services/razorpay.service.js";
import { ApiError } from "../middleware/errors.js";

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

/**
 * The member directory: every registered member, with ONLY the fields that are
 * safe to show to other members.
 *
 * Contact details (email, phone, the synthetic sign-in identifier) are
 * deliberately never included — the app exposes this list to every signed-in
 * user, so projecting the safe fields HERE, on the server, is the only place the
 * privacy line can be enforced (Firestore rules cannot hide individual fields).
 */
export async function listMembers(_req: AuthedRequest, res: Response) {
  const snap = await db.collection(collections.users).get();
  const members = snap.docs
    .map((doc) => {
      const d = doc.data() as any;
      return {
        uid: doc.id,
        name: (d.name || "").trim(),
        photoUrl: d.photoUrl || null,
        businessName: (d.businessName || "").trim(),
        businessCategory: (d.businessCategory || "").trim(),
        location: (d.location || "").trim(),
        chapter: d.chapter || null,
      };
    })
    // Skip half-built docs (e.g. an interrupted registration that only wrote a
    // login timestamp) — a nameless row is noise in a directory.
    .filter((m) => m.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ members });
}

export async function me(req: AuthedRequest, res: Response) {
  try {
    const normalizedEmail = (req.email || '').toLowerCase().trim();

    // 1. ALWAYS check admins collection FIRST
    const adminDoc = await db.collection(collections.admins).doc(req.uid).get();
    if (adminDoc.exists) {
      const adminData = adminDoc.data() as any;
      const resolvedRole = (adminData.role || (normalizedEmail.includes('superadmin') ? 'superadmin' : 'admin')).toLowerCase();
      return res.json({
        uid: req.uid,
        id: req.uid,
        name: adminData.name || (resolvedRole === 'superadmin' ? "Superadmin" : "Admin"),
        email: adminData.email || req.email || "",
        phone: adminData.mobile || "",
        region: adminData.region || "Global",
        role: resolvedRole,
        createdAt: toISO(adminData.grantedAt || adminData.createdAt),
      });
    }

    // 2. Check admins collection by email
    if (normalizedEmail) {
      const adminEmailSnap = await db.collection(collections.admins)
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();
      if (!adminEmailSnap.empty) {
        const adminData = adminEmailSnap.docs[0].data() as any;
        const resolvedRole = (adminData.role || (normalizedEmail.includes('superadmin') ? 'superadmin' : 'admin')).toLowerCase();
        return res.json({
          uid: req.uid,
          id: req.uid,
          name: adminData.name || (resolvedRole === 'superadmin' ? "Superadmin" : "Admin"),
          email: adminData.email || req.email,
          phone: adminData.mobile || "",
          region: adminData.region || "Global",
          role: resolvedRole,
          createdAt: toISO(adminData.grantedAt || adminData.createdAt),
        });
      }

      // 3. Fallback for admin or superadmin email patterns
      if (normalizedEmail.includes('superadmin') || normalizedEmail.includes('admin')) {
        const detectedRole = normalizedEmail.includes('superadmin') ? 'superadmin' : 'admin';
        return res.json({
          uid: req.uid,
          id: req.uid,
          name: detectedRole === 'superadmin' ? 'Superadmin' : 'Admin',
          email: req.email,
          phone: '',
          region: 'Global',
          role: detectedRole,
          createdAt: new Date().toISOString()
        });
      }
    }

    // 4. Query users collection by UID or email
    const userDoc = await db.collection(collections.users).doc(req.uid).get();
    let data = (userDoc.exists ? userDoc.data() : null) as any;

    if (!data && req.email) {
      const emailSnap = await db.collection(collections.users)
        .where('email', '==', req.email)
        .limit(1)
        .get();
      if (!emailSnap.empty) {
        data = emailSnap.docs[0].data() as any;
      }

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

    let isCaptainRole = false;

    // Check if user is registered as a Captain in a currently RUNNING / ACTIVE conclave
    if (req.email) {
      try {
        const conclavesSnap = await db.collection(collections.conclaves).get();
        for (const cDoc of conclavesSnap.docs) {
          const cData = cDoc.data();
          const cStatus = (cData.status || '').toLowerCase();
          
          // Captain role only applies while a conclave is actively RUNNING or ACTIVE.
          // Once a conclave ends/completes, captains revert to regular members!
          const isConclaveRunning = cStatus === 'running' || cStatus === 'active' || cStatus === 'in_progress' || cStatus === 'ongoing';
          
          if (!isConclaveRunning) continue;

          const regSnap = await db.collection(collections.conclaves).doc(cDoc.id).collection('registrations')
            .where('email', '==', req.email)
            .limit(1)
            .get();
          if (!regSnap.empty) {
            const reg = regSnap.docs[0].data();
            if (reg.role === 'captain' || reg.isCaptain === true || reg.isTableCaptain === true) {
              isCaptainRole = true;
              break;
            }
          }
        }
      } catch (_) {}
    }

    // Fallback to static user profile flag if user doc explicitly has isCaptain: true AND a running conclave exists
    if (!isCaptainRole && (data?.isCaptain === true || (data?.role || '').toLowerCase() === 'captain')) {
      try {
        const activeSnap = await db.collection(collections.conclaves)
          .where('status', 'in', ['running', 'active', 'in_progress', 'ongoing'])
          .limit(1)
          .get();
        if (!activeSnap.empty) {
          isCaptainRole = true;
        }
      } catch (_) {}
    }

    const dbRole = (data?.role || 'member').toLowerCase();
    const isSpecialRole = dbRole === 'superadmin' || dbRole === 'admin' || dbRole === 'regional_admin' || dbRole === 'coordinator';
    const finalRole = isCaptainRole ? 'captain' : (isSpecialRole ? dbRole : 'member');
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
      role: finalRole,
      isCaptain: isCaptainRole,
    });
  } catch (err: any) {
    const isErrAdmin = req.email?.toLowerCase().includes('admin');
    const isErrSuper = req.email?.toLowerCase().includes('superadmin');
    res.json({
      uid: req.uid,
      id: req.uid,
      name: isErrSuper ? "Superadmin" : isErrAdmin ? "Admin" : "Member",
      email: req.email || "",
      role: isErrSuper ? "superadmin" : isErrAdmin ? "admin" : "member"
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

/**
 * This member's referrals across EVERY conclave — the ones they gave, and the
 * ones they received. Self-scoped: the uid comes from the verified token, so a
 * caller can only ever read their own network, never someone else's.
 *
 * Iterates conclaves and queries each `referrals` subcollection (equality on a
 * single field, which the automatic index covers) rather than a collectionGroup
 * query, so it needs no extra index deployed to work.
 */
export async function myReferrals(req: AuthedRequest, res: Response) {
  const uid = req.uid;
  const conclavesSnap = await db.collection(collections.conclaves).get();

  type Row = {
    id: string;
    conclaveId: string;
    conclaveName: string;
    roundNumber: number;
    otherUserId: string;
    otherName: string;
    otherBusinessName: string;
    notes: string;
    createdAt: string;
  };

  const given: Row[] = [];
  const received: Row[] = [];

  await Promise.all(
    conclavesSnap.docs.map(async (c) => {
      const conclaveName = (c.data() as any).name || "Conclave";
      const refs = c.ref.collection(collections.referrals);

      const [givenSnap, recvSnap] = await Promise.all([
        refs.where("fromUserId", "==", uid).get(),
        refs.where("toUserId", "==", uid).get(),
      ]);

      givenSnap.forEach((d) => {
        const r = d.data() as any;
        given.push({
          id: d.id,
          conclaveId: c.id,
          conclaveName,
          roundNumber: Number(r.roundNumber ?? 0),
          otherUserId: String(r.toUserId ?? ""),
          otherName: r.toName ?? "",
          otherBusinessName: "",
          notes: r.notes ?? "",
          createdAt: toISO(r.createdAt || r.syncedAt),
        });
      });

      recvSnap.forEach((d) => {
        const r = d.data() as any;
        received.push({
          id: d.id,
          conclaveId: c.id,
          conclaveName,
          roundNumber: Number(r.roundNumber ?? 0),
          otherUserId: String(r.fromUserId ?? ""),
          otherName: r.fromName ?? "",
          otherBusinessName: "",
          notes: r.notes ?? "",
          createdAt: toISO(r.createdAt || r.syncedAt),
        });
      });
    }),
  );

  // Resolve counterpart name + business from the users collection, so the list
  // is consistent even for older referrals that didn't store a name inline.
  const ids = [
    ...new Set([...given, ...received].map((r) => r.otherUserId).filter(Boolean)),
  ];
  if (ids.length) {
    const docs = await db.getAll(
      ...ids.map((id) => db.collection(collections.users).doc(id)),
    );
    const users = new Map<string, { name: string; businessName: string }>();
    docs.forEach((d) => {
      if (d.exists) {
        const u = d.data() as any;
        users.set(d.id, {
          name: u.name || "",
          businessName: u.businessName || "",
        });
      }
    });
    for (const r of [...given, ...received]) {
      const u = users.get(r.otherUserId);
      if (u) {
        if (!r.otherName) r.otherName = u.name;
        r.otherBusinessName = u.businessName;
      }
    }
  }

  const byNewest = (a: Row, b: Row) => b.createdAt.localeCompare(a.createdAt);
  given.sort(byNewest);
  received.sort(byNewest);

  res.json({ given, received });
}

export async function register(req: AuthedRequest, res: Response) {
  const result = await registration.register(req.params.id, req.uid, req.body ?? {});
  res.json({
    message: result.alreadyRegistered ? "You are already registered." : "Registered.",
    ...result,
  });
}

/**
 * Open a Razorpay order for this conclave's registration fee.
 *
 * The eligibility check runs FIRST: we refuse to charge anyone who can't
 * actually register (closed, already in, or a time clash). The amount is the
 * conclave's fee — never a client-supplied number. The response carries the
 * public key_id and order id only; the secret never leaves the server.
 */
export async function createPaymentOrder(req: AuthedRequest, res: Response) {
  const conclaveId = req.params.id;

  if (!razorpayConfigured()) {
    // A clear, catchable signal so the app shows the offline path instead.
    throw new ApiError(503, "Online payment is not available. Please pay offline.");
  }

  const check = await registration.assertRegisterable(conclaveId, req.uid);
  if (check.alreadyRegistered) {
    throw ApiError.conflict("You are already registered for this conclave.");
  }

  const fee = registration.registrationFeeOf(check.conclave);
  if (fee <= 0) {
    throw ApiError.badRequest("This conclave has no registration fee.");
  }

  const order = await createOrder({ amountRupees: fee, uid: req.uid, conclaveId });
  res.json(order);
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
