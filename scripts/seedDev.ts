/**
 * Seed a LOCAL database with a demo conclave for developing the admin panel
 * and app: N generated members (deterministic), captains designated, registration
 * open. Members have fake uids (dev-1 …) and no Firebase login.
 *
 *   DATABASE_URL=postgres://localhost:5432/conclave_dev npm run seed -- [members=30]
 *
 * Refuses any non-local database.
 */
import { pool, pgdb } from "../src/db/client.js";
import { conclaves, registrations, users } from "../src/db/schema.js";
import { env } from "../src/config/env.js";
import { generateSeedParticipants } from "../src/data/seed.js";
import { tableCountFor } from "../src/engine/index.js";
import { audit } from "../src/audit/audit.service.js";
import { runAsSystem } from "../src/observability/context.js";

if (!/localhost|127\.0\.0\.1/.test(env.databaseUrl)) {
  console.error("Refusing to seed a non-local database.");
  process.exit(1);
}

const count = Math.max(4, Number(process.argv[2]) || 30);
const personsPerTable = 6;

async function run() {
  const people = generateSeedParticipants(count, Date.now() % 100_000);
  const captains = tableCountFor(count, personsPerTable);
  const id = await pgdb.transaction(async (tx) => {
    const [c] = await tx
      .insert(conclaves)
      .values({
        name: `Dev Demo Conclave ${new Date().toISOString().slice(0, 16)}`,
        venueLocation: "Demo Hall",
        region: "Guntur Region",
        startDate: new Date(Date.now() + 7 * 86_400_000),
        status: "registrationOpen",
        isRegistrationOpen: true,
        personsPerTable,
        roundCount: 4,
      })
      .returning();
    await tx
      .insert(users)
      .values(people.map((p) => ({ uid: `dev-${c.id.slice(0, 8)}-${p.id}`, name: p.name, phone: p.phone.replace(/\s/g, ""), company: p.businessName, category: p.businessCategory, chapter: p.chapter ?? null, lastLoginAt: new Date() })))
      .onConflictDoNothing();
    await tx.insert(registrations).values(
      people.map((p, i) => ({ conclaveId: c.id, userId: `dev-${c.id.slice(0, 8)}-${p.id}`, role: i < captains ? "captain" : "member", status: "confirmed" })),
    );
    await audit.system("data.seed_dev", { conclaveId: c.id, members: count, captains }, tx);
    return c.id;
  });
  console.log(`Seeded conclave ${id}: ${count} members, ${captains} captains. Generate the schedule from the admin panel.`);
}

runAsSystem("seed-dev", run, "script")
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e?.message ?? e);
    await pool.end();
    process.exit(1);
  });
