import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";
import { getForMember, listForMember } from "../services/conclave.service.js";
import { subscribe } from "../services/live.service.js";
import * as categoriesSvc from "../services/categories.service.js";
import { getAutoLogoutHours, getRoundTiming } from "../services/settings.service.js";
import { createOrder, razorpayConfigured } from "../services/razorpay.service.js";
import * as feedback from "../services/feedback.service.js";
import { ApiError } from "../middleware/errors.js";
import * as users from "../services/user.service.js";
import * as referralsSvc from "../services/referrals.service.js";
import * as oneToOnesSvc from "../services/oneToOnes.service.js";
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
  const profile = await users.updateMe(req.uid, req.body ?? {}, req.email);
  res.json({ success: true, message: "Profile updated successfully.", profile });
}

/** Every conclave, flagged with whether the caller is registered (contacts stripped). */
export async function listConclaves(req: AuthedRequest, res: Response) {
  res.json(await listForMember(req.uid, req.emailVerified ? req.email : undefined));
}

/** Referrals in this conclave that the caller gave or received — never anyone else's. */
export async function getReferrals(req: AuthedRequest, res: Response) {
  res.json(await referralsSvc.listMineInConclave(req.params.id, req.uid));
}

/** The caller's referral network across every conclave (self-scoped by the token). */
export async function myReferrals(req: AuthedRequest, res: Response) {
  res.json(await referralsSvc.myReferrals(req.uid));
}

/** The receiver records the business outcome (accepted / closed with amount / didn't work out). */
export async function updateReferralOutcome(req: AuthedRequest, res: Response) {
  res.json(await referralsSvc.updateOutcome(req.params.cid, req.params.rid, req.uid, req.body ?? {}));
}

// ---------------------------------------------------------------------------
// 1-2-1 meeting requests
//
// A member proposes a one-to-one with another member; the invited member
// accepts or declines. Stored in a top-level `oneToOnes` collection. The uid
// always comes from the verified token — you can only act on your own.
// ---------------------------------------------------------------------------
export async function createOneToOne(req: AuthedRequest, res: Response) {
  res.json(await oneToOnesSvc.create(req.uid, req.body ?? {}));
}

export async function listOneToOnes(req: AuthedRequest, res: Response) {
  res.json(await oneToOnesSvc.listMine(req.uid));
}

export async function updateOneToOne(req: AuthedRequest, res: Response) {
  res.json(await oneToOnesSvc.respond(req.uid, req.params.id, req.body?.status));
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


// ---- App data (replaces the app's direct Firestore reads) -----------------

/** Everything the app used to live-read from Firestore `settings/*`. */
export async function appConfig(_req: AuthedRequest, res: Response) {
  const [categories, roundTiming, autoLogoutHours] = await Promise.all([
    categoriesSvc.listCategories(),
    getRoundTiming(),
    getAutoLogoutHours(),
  ]);
  res.json({ categories, roundTiming, autoLogoutHours });
}

export async function getConclave(req: AuthedRequest, res: Response) {
  res.json(await getForMember(req.params.id, req.uid, req.emailVerified ? req.email : undefined));
}

/** Server-Sent Events: the conclave's live round state, pushed on every change. */
export async function conclaveLive(req: AuthedRequest, res: Response) {
  await subscribe(req.params.id, res as any);
}

export async function myProfile(req: AuthedRequest, res: Response) {
  const profile = await users.getOwnProfile(req.uid);
  if (!profile) throw ApiError.notFound("No profile yet.");
  res.json(profile);
}

export async function setMyPhoto(req: AuthedRequest, res: Response) {
  res.json(await users.setPhoto(req.uid, req.body?.dataUrl));
}

export async function removeMyPhoto(req: AuthedRequest, res: Response) {
  await users.removePhoto(req.uid);
  res.json({ ok: true });
}

/** The business categories a member can pick from (web sign-up and profile). */
export async function listCategories(_req: AuthedRequest, res: Response) {
  res.json({ categories: await categoriesSvc.listCategories() });
}
