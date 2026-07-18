import { auth, db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import type { UserDoc } from "./user.service.js";

/**
 * Admin-triggered password reset.
 *
 * Why this exists: Firebase has no phone+password sign-in, so a phone
 * registration is keyed by a SYNTHETIC address (919515409973@bni121.conclave).
 * No mailbox receives that, so the normal "email me a reset link" flow has
 * nowhere to send to, and a member who forgets their password is simply stuck.
 *
 * The Admin SDK's generatePasswordResetLink RETURNS the link rather than
 * emailing it, which is what makes this possible with no mail service wired up:
 * the admin gets a URL and sends it to the member over WhatsApp or SMS — a
 * BNI admin already has these people in their phone.
 *
 * The member sets their own password, so the admin never learns it. That is
 * strictly better than the obvious alternative (admin types a temporary
 * password and reads it out), and it is why this is a link rather than a
 * password.
 */
export interface ResetLinkResult {
  link: string;
  /** Where the admin should send it. Empty for accounts predating both-contacts. */
  email: string;
  phone: string;
  name: string;
  /** True when this is a phone account, i.e. self-serve reset is impossible. */
  isPhoneAccount: boolean;
  expiresInHours: number;
}

/** Firebase's default action-link lifetime. */
const LINK_TTL_HOURS = 1;

export async function generateResetLink(uid: string): Promise<ResetLinkResult> {
  const userDoc = await db.collection(collections.users).doc(uid).get();
  if (!userDoc.exists) throw ApiError.notFound("No such user.");

  const profile = userDoc.data() as UserDoc;

  // The account's Firebase identity, which is what the link must be generated
  // against — NOT the member's real email, which Firebase has never heard of.
  let authEmail: string;
  try {
    authEmail = (await auth.getUser(uid)).email ?? "";
  } catch {
    throw ApiError.notFound("That user has no authentication account.");
  }

  if (!authEmail) {
    throw ApiError.conflict(
      "That account has no password sign-in configured, so there is nothing to reset.",
    );
  }

  const isPhoneAccount = authEmail.endsWith("@bni121.conclave");

  let link: string;
  try {
    link = await auth.generatePasswordResetLink(authEmail);
  } catch (e) {
    throw ApiError.badRequest(
      `Could not generate a reset link: ${(e as Error).message}`,
    );
  }

  return {
    link,
    // Deliberately the REAL contacts, not authEmail — the admin needs somewhere
    // they can actually reach, and for a phone account authEmail is fiction.
    email: profile.email ?? "",
    phone: profile.phone ?? "",
    name: profile.name ?? "",
    isPhoneAccount,
    expiresInHours: LINK_TTL_HOURS,
  };
}

/**
 * Finds a member by email or phone, so an admin can act on "I can't get in"
 * without hunting through a conclave's roster.
 *
 * Admin-only. As a public endpoint this would be a membership-enumeration
 * oracle.
 */
export async function findUser(query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) throw ApiError.badRequest("Enter at least 3 characters.");

  const users = db.collection(collections.users);

  // Exact matches first — the fields people actually search by.
  const [byEmail, byPhone, byIdentifier] = await Promise.all([
    users.where("email", "==", q).limit(5).get(),
    users.where("phone", "==", query.trim()).limit(5).get(),
    users.where("identifier", "==", query.trim()).limit(5).get(),
  ]);

  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const snap of [byEmail, byPhone, byIdentifier]) {
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const u = doc.data() as UserDoc;
      results.push({
        uid: doc.id,
        name: u.name ?? "",
        email: u.email ?? "",
        phone: u.phone ?? "",
        businessName: u.businessName ?? "",
        businessCategory: u.businessCategory ?? "",
      });
    }
  }

  return results;
}
