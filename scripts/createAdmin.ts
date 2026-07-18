/**
 * Create an admin account.
 *
 *   npm run create-admin -- admin@example.com "a-strong-password"
 *
 * Admins are created by hand, deliberately. This creates the Firebase Auth user
 * if it doesn't exist, then writes `admins/{uid}` — and it is that DOCUMENT, not
 * merely being signed in, that the server treats as the grant.
 *
 * To revoke: delete admins/{uid}. The account can still sign in, but every
 * /api/admin/* call will 403 (within the 60s allowlist cache TTL).
 */
import { auth, db, collections } from "../src/config/firebase.js";

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: npm run create-admin -- <email> "<password>"');
  process.exit(1);
}

const run = async () => {
  let uid: string;

  try {
    uid = (await auth.getUserByEmail(email)).uid;
    console.log(`User already exists (${uid}) — granting admin.`);
  } catch {
    uid = (await auth.createUser({ email, password, emailVerified: true })).uid;
    console.log(`Created auth user ${uid}.`);
  }

  await db.collection(collections.admins).doc(uid).set({
    email,
    grantedAt: new Date(),
  });

  console.log(`\n${email} is now an admin (admins/${uid}).`);
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Failed:", e?.message ?? e);
    process.exit(1);
  });
