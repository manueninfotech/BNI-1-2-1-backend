/**
 * Seed a completed conclave + referral data, so the "My referrals" screen and
 * the member directory have something to show while testing.
 *
 * Idempotent: deterministic doc ids, so re-running overwrites rather than
 * duplicating. Every REAL member gets 2 referrals given and 2 received, so
 * whoever is signed in sees both tabs populated.
 *
 *   npx tsx scripts/seedReferrals.ts
 *
 * To remove afterwards:
 *   npx tsx scripts/seedReferrals.ts --clean
 */
import { db, collections } from "../src/config/firebase.js";

const CLEAN = process.argv.includes("--clean");
const CONCLAVE_ID = "seed-conclave-referrals";

const DUMMIES = [
  { name: "Anita Rao", businessName: "Rao Interiors", businessCategory: "Design", location: "guntur" },
  { name: "Vikram Shah", businessName: "Shah & Associates", businessCategory: "Legal Services", location: "guntur" },
  { name: "Priya Menon", businessName: "Menon Dental Care", businessCategory: "Health & Medical", location: "vijayawada" },
  { name: "Rahul Gupta", businessName: "Gupta Realty", businessCategory: "Real Estate", location: "guntur" },
  { name: "Sana Khan", businessName: "Khan Photography", businessCategory: "Art & Photography", location: "guntur" },
];

const NOTES = [
  "Looking for a new office fit-out.",
  "Wants a brand refresh before launch.",
  "",
  "Needs help with a property deal.",
  "",
  "Asked about tax planning.",
];

async function clean() {
  const refs = await db.collection(collections.conclaves).doc(CONCLAVE_ID)
    .collection(collections.referrals).get();
  const batch = db.batch();
  refs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection(collections.conclaves).doc(CONCLAVE_ID));
  for (let i = 0; i < DUMMIES.length; i++) {
    batch.delete(db.collection(collections.users).doc(`seed-member-${i + 1}`));
  }
  await batch.commit();
  console.log("Removed seed conclave, referrals and dummy members.");
}

async function seed() {
  // 1. Dummy members (also fill out the directory).
  const dummyIds: string[] = [];
  for (let i = 0; i < DUMMIES.length; i++) {
    const id = `seed-member-${i + 1}`;
    await db.collection(collections.users).doc(id).set(
      {
        id,
        ...DUMMIES[i],
        email: `seed${i + 1}@conclave.test`,
        phone: "",
        identifier: `seed${i + 1}@conclave.test`,
        country: "India",
        createdAt: new Date(),
      },
      { merge: true },
    );
    dummyIds.push(id);
  }

  // 2. Real members = everyone already in users, minus our dummies.
  const usersSnap = await db.collection(collections.users).get();
  const realIds = usersSnap.docs
    .map((d) => d.id)
    .filter((id) => !id.startsWith("seed-member-"));

  console.log(`Real members: ${realIds.length}, dummies: ${dummyIds.length}`);

  // 3. A completed conclave to hang the referrals off.
  const conclaveRef = db.collection(collections.conclaves).doc(CONCLAVE_ID);
  await conclaveRef.set(
    {
      name: "Guntur Central — Seed Conclave",
      venueLocation: "Guntur",
      status: "completed",
      date: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      roundCount: 4,
      personsPerTable: 7,
      createdAt: new Date(),
    },
    { merge: true },
  );

  // 4. Referrals. Give every REAL member 2 given + 2 received against dummies,
  //    plus a little dummy-to-dummy traffic so the dummies' profiles look alive.
  const refs = conclaveRef.collection(collections.referrals);
  const batch = db.batch();
  let n = 0;

  const pickDummy = (not: string) => {
    const pool = dummyIds.filter((x) => x !== not);
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const mkDate = (h: number) =>
    new Date(Date.now() - h * 3_600_000).toISOString();

  const add = (from: string, to: string, round: number, tag: string) => {
    batch.set(refs.doc(`seed-${from}-${tag}`), {
      fromUserId: from,
      toUserId: to,
      roundNumber: round,
      notes: NOTES[n % NOTES.length],
      status: "Confirmed",
      createdAt: mkDate(n + 1),
      syncedAt: new Date(),
    });
    n++;
  };

  for (const uid of realIds) {
    add(uid, pickDummy(""), 1, "give-1");
    add(uid, pickDummy(""), 2, "give-2");
    add(pickDummy(""), uid, 3, "recv-1");
    add(pickDummy(""), uid, 4, "recv-2");
  }
  // dummy-to-dummy
  for (let i = 0; i < dummyIds.length; i++) {
    add(dummyIds[i], dummyIds[(i + 1) % dummyIds.length], (i % 4) + 1, "dd");
  }

  await batch.commit();
  console.log(`Seeded conclave + ${n} referrals.`);
}

(CLEAN ? clean() : seed())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Failed:", e?.message ?? e);
    process.exit(1);
  });
