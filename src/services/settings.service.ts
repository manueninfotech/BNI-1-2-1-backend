import { db, collections } from "../config/firebase.js";

export const DEFAULT_AUTO_LOGOUT_HOURS = 5;

/**
 * The app-wide auto-logout window, from `settings/app`.
 *
 * Cached: it is read on most requests, it changes almost never, and each read is
 * a full Firestore round trip.
 */
let cache: { value: number; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function getAutoLogoutHours(): Promise<number> {
  if (cache && Date.now() < cache.expiresAt) return cache.value;

  let value = DEFAULT_AUTO_LOGOUT_HOURS;
  try {
    const doc = await db.collection(collections.settings).doc("app").get();
    const hours = doc.data()?.autoLogoutHours;
    if (typeof hours === "number" && hours > 0) value = hours;
  } catch {
    // Unreachable settings must not take the API down; the default is sane.
  }

  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}
