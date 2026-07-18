import { initializeApp, cert, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { env } from "./env.js";

/**
 * Firebase Admin, initialised once.
 *
 * Serverless platforms reuse warm instances, so this guards against a second
 * initializeApp() on an already-initialised process.
 */
function credential() {
  if (env.firebaseServiceAccount) {
    const raw = env.firebaseServiceAccount.trim();
    // Accept base64 too: some hosts mangle the newlines inside the private key.
    const json = raw.startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return cert(JSON.parse(json));
  }

  // Falls back to GOOGLE_APPLICATION_CREDENTIALS / workload identity.
  return applicationDefault();
}

if (getApps().length === 0) {
  initializeApp({ credential: credential() });
}

export const db: Firestore = getFirestore();
export const auth: Auth = getAuth();
export const messaging: Messaging = getMessaging();

/** Firestore collection names, so a typo can't silently create a new one. */
export const collections = {
  conclaves: "conclaves",
  users: "users",
  admins: "admins",
  settings: "settings",
  // subcollections of a conclave
  registrations: "registrations",
  attendance: "attendance",
  referrals: "referrals",
} as const;
