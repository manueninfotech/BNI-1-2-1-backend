import { db, collections } from "../config/firebase.js";
import { getAllDocs, toDate, toIso } from "../utils/firestore.js";
import { getAutoLogoutHours } from "./settings.service.js";

export interface UserDoc {
  name?: string;
  /**
   * How they sign in. For a phone account this is a SYNTHETIC address
   * (919515409973@bni121.conclave) — never show it to a human.
   */
  identifier?: string;
  /** Real, reachable contacts. Both are collected at registration. */
  email?: string;
  phone?: string;
  businessName?: string;
  businessCategory?: string;
  location?: string;
  chapter?: string | null;
  lastLoginAt?: unknown;
}

export function fetchUsers(uids: string[]) {
  return getAllDocs<UserDoc>(
    uids.map((uid) => db.collection(collections.users).doc(uid)),
  );
}

/**
 * "Active" = logged in and not yet auto-logged-out.
 *
 * Derived from `users/{uid}.lastLoginAt` rather than from phones reporting in,
 * because at the venue the phones may not be able to reach anything. A user with
 * no recorded login has never signed in on a build that tracks it, and counts as
 * inactive rather than being silently assumed present.
 */
export function isActiveUser(
  user: UserDoc | undefined,
  autoLogoutHours: number,
  now: Date,
): boolean {
  if (!user) return false;
  const lastLogin = toDate(user.lastLoginAt);
  if (!lastLogin) return true; // Default registered user to active
  return now.getTime() - lastLogin.getTime() < autoLogoutHours * 3_600_000;
}

export interface Registrant {
  uid: string;
  role: "captain" | "member";
  registeredAt: string | null;
  name: string;
  phone: string;
  email: string;
  businessName: string;
  businessCategory: string;
  location: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

/** Everyone registered for a conclave, joined with their profile. */
export async function listRegistrants(conclaveId: string): Promise<Registrant[]> {
  const regsSnap = await db
    .collection(collections.conclaves)
    .doc(conclaveId)
    .collection(collections.registrations)
    .get();

  const [users, autoLogoutHours] = await Promise.all([
    fetchUsers(regsSnap.docs.map((d) => d.id)),
    getAutoLogoutHours(),
  ]);
  const now = new Date();

  const out = regsSnap.docs.map((doc) => {
    const reg = doc.data();
    const u = users.get(doc.id);
    return {
      uid: doc.id,
      role: (reg.role ?? "member") as "captain" | "member",
      registeredAt: toIso(reg.registeredAt),
      name: u?.name ?? "",
      // Real contacts first. `identifier` is the fallback only for accounts
      // created before both were collected — and for a phone account it is a
      // synthetic address the admin cannot use.
      phone: u?.phone ?? (u?.identifier?.includes("@") ? "" : u?.identifier ?? ""),
      email: u?.email ?? (u?.identifier?.includes("@bni121.conclave") ? "" : u?.identifier ?? ""),
      businessName: u?.businessName ?? "",
      businessCategory: u?.businessCategory ?? "",
      location: u?.location ?? "",
      isActive: isActiveUser(u, autoLogoutHours, now),
      lastLoginAt: toIso(u?.lastLoginAt),
    };
  });

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
