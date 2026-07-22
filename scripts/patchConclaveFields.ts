/**
 * Patch existing conclave documents in Firestore with missing metadata fields.
 * Run with: npx tsx scripts/patchConclaveFields.ts
 *
 * This script sets `region`, `description`, and `coordinator` on every
 * conclave document that does not already have those fields populated.
 * It never overwrites an existing non-empty value.
 */
import { db, collections } from "../src/config/firebase.js";

async function run() {
  const snap = await db.collection(collections.conclaves).get();

  if (snap.empty) {
    console.log("No conclaves found in Firestore.");
    return;
  }

  console.log(`Found ${snap.size} conclave(s). Checking for missing fields…\n`);

  let patched = 0;

  for (const doc of snap.docs) {
    const d = doc.data();

    const updates: Record<string, unknown> = {};

    // ── region ────────────────────────────────────────────────────────────
    if (!d.region) {
      // Derive from venueLocation if possible, else use default
      const venue: string = d.venueLocation ?? d.name ?? "";
      updates.region = venue.toLowerCase().includes("hyderabad")
        ? "Hyderabad Region"
        : "Guntur Region";
    }

    // ── description ───────────────────────────────────────────────────────
    if (!d.description) {
      updates.description =
        `BNI 1-2-1 Conclave — speed-networking event for ${d.region ?? updates.region ?? "Guntur Region"} business leaders. ` +
        `Members meet one-on-one across structured rounds to build referral relationships.`;
    }

    // ── coordinator ───────────────────────────────────────────────────────
    if (!d.coordinator) {
      // Try to pull the coordinator name from the admins collection
      const adminSnap = await db
        .collection(collections.admins)
        .where("role", "==", "coordinator")
        .limit(1)
        .get();

      if (!adminSnap.empty) {
        const adminData = adminSnap.docs[0].data();
        updates.coordinator = adminData.name ?? "Sanjay Wagle";
      } else {
        updates.coordinator = "Sanjay Wagle";
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  ✓ [${doc.id}] "${d.name}" — all fields already present, skipped.`);
      continue;
    }

    await doc.ref.set(updates, { merge: true });
    patched++;

    console.log(`  ✎ [${doc.id}] "${d.name}" — patched:`, updates);
  }

  console.log(`\nDone. ${patched} conclave(s) patched.`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
