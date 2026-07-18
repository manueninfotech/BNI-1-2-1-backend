/**
 * Prints the Firestore ruleset Firestore is ACTUALLY enforcing right now.
 *
 * Reading firestore.rules from the repo tells you what you meant to deploy; this
 * tells you what is live. Those are different things, and the gap is where the
 * database sits unprotected.
 */
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "conclave-1-2-1";

async function main() {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/firebase.readonly"],
  });
  const client = await auth.getClient();

  const releases: any = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`,
  });

  const fs = releases.data.releases?.find((r: any) => r.name.endsWith("cloud.firestore"));
  if (!fs) {
    console.log("No Firestore ruleset is released.");
    return;
  }

  console.log("live ruleset :", fs.rulesetName);
  console.log("last updated :", fs.updateTime);

  const ruleset: any = await client.request({
    url: `https://firebaserules.googleapis.com/v1/${fs.rulesetName}`,
  });

  console.log("\n===== ENFORCED SOURCE =====\n");
  console.log(ruleset.data.source.files[0].content);
}

main().catch((e) => {
  console.error("Failed:", e?.message ?? e);
  process.exit(1);
});
