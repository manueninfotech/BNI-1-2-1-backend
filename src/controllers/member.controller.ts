import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, collections } from "../config/firebase.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";
import { listConclaves as listConclaveRecords } from "../services/conclave.service.js";
import { createOrder, razorpayConfigured } from "../services/razorpay.service.js";
import * as feedback from "../services/feedback.service.js";
import {
  notifyUser,
  sendDataToUser,
  recordUserNotification,
} from "../services/notification.service.js";
import { ApiError } from "../middleware/errors.js";
import * as users from "../services/user.service.js";
import * as notificationsSvc from "../services/notifications.service.js";

export async function listNotifications(req: AuthedRequest, res: Response) {
  res.json(await notificationsSvc.listForUser(req.uid));
}

export async function markNotificationsRead(req: AuthedRequest, res: Response) {
  const marked = await notificationsSvc.markAllRead(req.uid);
  res.json({ ok: true, marked });
}

/**
 * Permanently deletes the caller's own account — required by App Store Guideline
 * 5.1.1(v). The uid comes from the verified token, so a member can only ever
 * delete themselves.
 */
export async function deleteAccount(req: AuthedRequest, res: Response) {
  await users.deleteOwnAccount(req.uid);
  res.json({ ok: true });
}

const displayName = users.displayName;

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
 * The member directory — ONLY fields safe to show to other members (no email,
 * phone or sign-in identifier). Enforced server-side in users.listMemberDirectory.
 */
export async function listMembers(_req: AuthedRequest, res: Response) {
  res.json({ members: await users.listMemberDirectory() });
}

export async function me(req: AuthedRequest, res: Response) {
  res.json(await users.getMe({ uid: req.uid, email: req.email, emailVerified: req.emailVerified }));
}

export async function updateMe(req: AuthedRequest, res: Response) {
  const profile = await users.updateMe(req.uid, req.body ?? {});
  res.json({ success: true, message: "Profile updated successfully.", profile });
}

export async function listConclaves(req: AuthedRequest, res: Response) {
  const list = await listConclaveRecords();
  const userDoc = await db.collection(collections.users).doc(req.uid).get();
  const userData = (userDoc.exists ? userDoc.data() : {}) as any;
  const userEmail = (userData.email || req.email || '').toLowerCase().trim();
  const rawPhone = String(userData.phone || userData.mobile || userData.identifier || '').replace(/\D/g, '');
  const userPhone = rawPhone.length >= 10 ? rawPhone.slice(-10) : rawPhone;

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

      // Fallback: search by email or identifier
      if (userEmail) {
        const byEmail = await db
          .collection(collections.conclaves)
          .doc(c.id)
          .collection(collections.registrations)
          .where('email', '==', userEmail)
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
          .where('identifier', '==', userEmail)
          .limit(1)
          .get();
        if (!byIdentifier.empty) {
          registeredSet.add(c.id);
          return;
        }
      }

      // Fallback: search by Phone number matching
      if (userPhone) {
        const regsSnap = await db
          .collection(collections.conclaves)
          .doc(c.id)
          .collection(collections.registrations)
          .get();
        for (const doc of regsSnap.docs) {
          const r = doc.data() as any;
          const regPhoneRaw = String(r.phone || r.mobile || r.identifier || '').replace(/\D/g, '');
          const regPhone = regPhoneRaw.length >= 10 ? regPhoneRaw.slice(-10) : regPhoneRaw;
          if (regPhone && userPhone && regPhone === userPhone) {
            registeredSet.add(c.id);
            return;
          }
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
    status: string;
    // Business-outcome lifecycle, driven by the RECEIVER of the referral.
    outcome: string; // 'open' | 'accepted' | 'closed' | 'not_closed'
    closedAmount: number; // TYFCB value in rupees, when closed
    outcomeNote: string;
    outcomeAt: string | null;
    createdAt: string;
  };

  const outcomeFields = (r: any) => ({
    outcome: (r.outcome as string) || "open",
    closedAmount: Number(r.closedAmount ?? 0),
    outcomeNote: (r.outcomeNote as string) || "",
    outcomeAt: r.outcomeAt ? toISO(r.outcomeAt) : null,
  });

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
          status: r.status || "Pending",
          ...outcomeFields(r),
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
          status: r.status || "Pending",
          ...outcomeFields(r),
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

/**
 * Records the business outcome of a referral: the lifecycle a RECEIVER drives —
 * accepted, closed (with a TYFCB amount), or didn't work out.
 *
 * Only the person who RECEIVED the referral may update it — the outcome is their
 * report of what happened, and it credits the giver. The uid comes from the
 * token, so a caller can never touch a referral that wasn't theirs to close.
 */
const OUTCOMES = new Set(["open", "accepted", "closed", "not_closed"]);

export async function updateReferralOutcome(req: AuthedRequest, res: Response) {
  const { cid, rid } = req.params;
  const outcome = String(req.body?.outcome || "").trim();
  const amount = Number(req.body?.amount ?? 0);
  const note = String(req.body?.note ?? "").trim();

  if (!OUTCOMES.has(outcome)) {
    throw new ApiError(400, "Invalid outcome.");
  }
  if (outcome === "closed" && (!Number.isFinite(amount) || amount < 0)) {
    throw new ApiError(400, "A closed referral needs a valid amount.");
  }

  const ref = db
    .collection(collections.conclaves)
    .doc(cid)
    .collection(collections.referrals)
    .doc(rid);

  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "Referral not found.");
  if ((snap.data() as any).toUserId !== req.uid) {
    throw new ApiError(403, "Only the member who received a referral can update it.");
  }

  const newStatus = (outcome === "accepted" || outcome === "closed") ? "Completed" : ((snap.data() as any).status || "Pending");

  await ref.set(
    {
      outcome,
      status: newStatus,
      closedAmount: outcome === "closed" ? amount : 0,
      outcomeNote: note,
      outcomeAt: new Date().toISOString(),
    },
    { merge: true },
  );

  res.json({ ok: true, outcome, status: newStatus, closedAmount: outcome === "closed" ? amount : 0 });
}

// ---------------------------------------------------------------------------
// 1-2-1 meeting requests
//
// A member proposes a one-to-one with another member; the invited member
// accepts or declines. Stored in a top-level `oneToOnes` collection. The uid
// always comes from the verified token — you can only act on your own.
// ---------------------------------------------------------------------------
const ONE_TO_ONES = "oneToOnes";

export async function createOneToOne(req: AuthedRequest, res: Response) {
  const uid = req.uid;
  const toUserId = String(req.body?.toUserId || "").trim();
  const proposedAt = String(req.body?.proposedAt || "").trim();
  const location = String(req.body?.location || "").trim();
  const note = String(req.body?.note || "").trim();

  if (!toUserId) throw new ApiError(400, "Choose a member.");
  if (toUserId === uid) throw new ApiError(400, "You can't book a 1-2-1 with yourself.");
  if (!proposedAt || Number.isNaN(Date.parse(proposedAt))) {
    throw new ApiError(400, "Pick a valid date and time.");
  }
  const toDoc = await db.collection(collections.users).doc(toUserId).get();
  if (!toDoc.exists) throw new ApiError(404, "Member not found.");

  // Guard against spamming the same member. Two equality filters need no
  // composite index.
  const priorSnap = await db
    .collection(ONE_TO_ONES)
    .where("fromUserId", "==", uid)
    .where("toUserId", "==", toUserId)
    .get();

  const hasPending = priorSnap.docs.some(
    (d) => (d.data() as any).status === "pending",
  );
  if (hasPending) {
    throw new ApiError(
      409,
      "You already have a pending 1-2-1 request with this member.",
    );
  }

  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = priorSnap.docs.filter((d) => {
    const t = Date.parse((d.data() as any).createdAt || "");
    return !Number.isNaN(t) && t >= monthAgo;
  }).length;
  if (recent >= 2) {
    throw new ApiError(
      429,
      "You can request a 1-2-1 with the same member at most twice a month.",
    );
  }

  const now = new Date().toISOString();
  const ref = await db.collection(ONE_TO_ONES).add({
    fromUserId: uid,
    toUserId,
    proposedAt,
    location,
    note,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  // Data-only push so the app raises a notification with Accept / Decline
  // actions the invited member can tap from the tray.
  const fromName = await displayName(uid);
  void sendDataToUser(toUserId, {
    type: "one_to_one_request",
    id: ref.id,
    fromName,
  });
  void recordUserNotification(toUserId, {
    title: "New 1-2-1 request",
    body: `${fromName} wants a one-to-one with you.`,
    type: "one_to_one_request",
    data: { id: ref.id },
  });

  res.json({ id: ref.id });
}

export async function listOneToOnes(req: AuthedRequest, res: Response) {
  const uid = req.uid;
  const col = db.collection(ONE_TO_ONES);
  const [sentSnap, recvSnap] = await Promise.all([
    col.where("fromUserId", "==", uid).get(),
    col.where("toUserId", "==", uid).get(),
  ]);

  const raw: {
    id: string;
    direction: "sent" | "received";
    otherUserId: string;
    data: any;
  }[] = [];
  sentSnap.forEach((d) =>
    raw.push({ id: d.id, direction: "sent", otherUserId: (d.data() as any).toUserId, data: d.data() }),
  );
  recvSnap.forEach((d) =>
    raw.push({ id: d.id, direction: "received", otherUserId: (d.data() as any).fromUserId, data: d.data() }),
  );

  const ids = [...new Set(raw.map((r) => r.otherUserId).filter(Boolean))];
  const users = new Map<string, { name: string; businessName: string; photoUrl: string | null }>();
  if (ids.length) {
    const docs = await db.getAll(...ids.map((id) => db.collection(collections.users).doc(id)));
    docs.forEach((d) => {
      if (d.exists) {
        const u = d.data() as any;
        users.set(d.id, {
          name: u.name || "",
          businessName: u.businessName || "",
          photoUrl: u.photoUrl || null,
        });
      }
    });
  }

  const oneToOnes = raw
    .map((r) => {
      const u = users.get(r.otherUserId);
      return {
        id: r.id,
        direction: r.direction,
        otherUserId: r.otherUserId,
        otherName: u?.name || "",
        otherBusinessName: u?.businessName || "",
        otherPhotoUrl: u?.photoUrl || null,
        proposedAt: r.data.proposedAt || "",
        location: r.data.location || "",
        note: r.data.note || "",
        status: r.data.status || "pending",
        createdAt: r.data.createdAt || null,
      };
    })
    .sort((a, b) => (a.proposedAt || "").localeCompare(b.proposedAt || ""));

  res.json({ oneToOnes });
}

export async function updateOneToOne(req: AuthedRequest, res: Response) {
  const uid = req.uid;
  const { id } = req.params;
  const status = String(req.body?.status || "").trim();

  if (!["accepted", "declined", "cancelled"].includes(status)) {
    throw new ApiError(400, "Invalid status.");
  }

  const ref = db.collection(ONE_TO_ONES).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "1-2-1 not found.");
  const m = snap.data() as any;

  const isReceiver = m.toUserId === uid;
  const isSender = m.fromUserId === uid;
  if (!isReceiver && !isSender) throw new ApiError(403, "Not your 1-2-1.");
  // Only the invited member accepts/declines; either party may cancel.
  if ((status === "accepted" || status === "declined") && !isReceiver) {
    throw new ApiError(403, "Only the invited member can respond.");
  }

  await ref.set({ status, updatedAt: new Date().toISOString() }, { merge: true });

  // Notify the OTHER party of the change.
  const actorName = await displayName(uid);
  if (status === "accepted" || status === "declined") {
    const msg = {
      title: `1-2-1 ${status}`,
      body: `${actorName} ${status} your 1-2-1 request.`,
      data: { type: "one_to_one", id },
    };
    void notifyUser(m.fromUserId, msg, "one_to_ones");
    void recordUserNotification(m.fromUserId, { ...msg, type: "one_to_one" });
  } else if (status === "cancelled") {
    const target = isSender ? m.toUserId : m.fromUserId;
    const msg = {
      title: "1-2-1 cancelled",
      body: `${actorName} cancelled a 1-2-1.`,
      data: { type: "one_to_one", id },
    };
    void notifyUser(target, msg, "one_to_ones");
    void recordUserNotification(target, { ...msg, type: "one_to_one" });
  }

  res.json({ ok: true, status });
}

export async function register(req: AuthedRequest, res: Response) {
  const result = await registration.register(req.params.id, req.uid, req.body ?? {});
  res.json({
    message: result.alreadyRegistered ? "You are already registered." : "Registered.",
    ...result,
  });
}

export async function submitFeedback(req: AuthedRequest, res: Response) {
  res.json(await feedback.submitFeedback(req.params.id, req.uid, req.body ?? {}));
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

/** Withdraw — only before a schedule exists and never once paid (see registration.service). */
export async function deregister(req: AuthedRequest, res: Response) {
  await registration.deregister(req.params.id, req.uid);
  res.json({ message: "Registration cancelled." });
}

export async function syncConclave(req: AuthedRequest, res: Response) {
  const result = await sync.syncConclave(
    req.params.id,
    req.uid, // from the verified token — NEVER from the body
    req.body ?? {},
  );

  res.json(result);
}

/**
 * PUBLIC: maps an email/phone to the Firebase sign-in address. Returns only
 * that address — no profile fields and no "found" flag (anti-enumeration).
 */
export async function resolveIdentifier(req: AuthedRequest, res: Response) {
  res.json({ authEmail: await users.resolveSignInAddress(req.body?.identifier) });
}

