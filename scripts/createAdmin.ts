/**
 * Create (or re-grant) an admin-panel account.
 *
 *   npm run create-admin -- admin@example.com "a-strong-password" [superadmin|admin|coordinator]
 *
 * Admins are created by hand, deliberately. This creates the Firebase login if
 * it doesn't exist, then upserts the `admins` row — and it is that ROW, not
 * merely being signed in, that the server treats as the grant. Audited as a
 * script action.
 *
 * To revoke: delete the row (or set status Inactive) from the admin panel.
 */
import { sql } from "drizzle-orm";
import { auth } from "../src/config/firebase.js";
import { pgdb, pool } from "../src/db/client.js";
import { admins } from "../src/db/schema.js";
import { audit } from "../src/audit/audit.service.js";
import { runAsSystem } from "../src/observability/context.js";

const [emailArg, password, roleArg = "admin"] = process.argv.slice(2);
const email = (emailArg ?? "").trim().toLowerCase();
const role = roleArg.toLowerCase();

if (!email || !password || !["superadmin", "admin", "coordinator"].includes(role)) {
  console.error('Usage: npm run create-admin -- <email> "<password>" [superadmin|admin|coordinator]');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

async function run() {
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(email)).uid;
    console.log(`Login already exists (${uid}) — granting ${role}.`);
  } catch {
    uid = (await auth.createUser({ email, password, emailVerified: true })).uid;
    console.log(`Created login ${uid}.`);
  }

  await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(admins).where(sql`lower(${admins.email}) = ${email}`);
    const [after] = await tx
      .insert(admins)
      .values({ uid, email, role, status: "Active", name: email.split("@")[0] })
      .onConflictDoUpdate({ target: admins.uid, set: { role, status: "Active", updatedAt: new Date() } })
      .returning();
    await audit.change({ action: before ? "admin.update" : "admin.create", entityType: "admin", entityId: uid, before: before ?? null, after }, tx);
  });
  console.log(`\n${email} is now ${role}.`);
}

runAsSystem("create-admin", run, "script")
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("Failed:", e?.message ?? e);
    await pool.end();
    process.exit(1);
  });
