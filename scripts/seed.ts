/**
 * Seed a conclave with the 12 dry-run participants (+ Eb as captain).
 *   npm run seed -- <conclaveId>
 */
import { auth, db, collections } from "../src/config/firebase.js";

const NAMES = ["sravanreddy","bhanuprakash","kartheekrao","priyasharma","anitareddy",
  "vikramsingh","meenakumari","rahulverma","sureshbabu","lakshmidevi","arjunnair","divyamenon"];

const run = async () => {
  const cid = process.argv[2];
  if (!cid) throw new Error("Usage: npm run seed -- <conclaveId>");
  const now = new Date();
  const batch = db.batch();

  for (const n of NAMES) {
    const uid = (await auth.getUserByEmail(`${n}@dryrun.test`)).uid;
    batch.set(
      db.collection(collections.conclaves).doc(cid).collection(collections.registrations).doc(uid),
      { userId: uid, registeredAt: now, role: "member", status: "pending" },
    );
    batch.set(db.collection(collections.users).doc(uid), { lastLoginAt: now }, { merge: true });
  }

  // Eb -> captain (the real device)
  const eb = (await db.collection(collections.users).where("name", "==", "Eb").limit(1).get()).docs[0];
  batch.set(
    db.collection(collections.conclaves).doc(cid).collection(collections.registrations).doc(eb.id),
    { userId: eb.id, registeredAt: now, role: "captain", status: "pending" },
  );
  batch.set(db.collection(collections.users).doc(eb.id), { lastLoginAt: now }, { merge: true });

  await batch.commit();
  console.log(`seeded 13 into ${cid} (Eb = captain)`);
};

run().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
