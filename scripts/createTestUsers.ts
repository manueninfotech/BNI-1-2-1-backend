import { auth } from "../src/config/firebase.js";
import { pgdb, pool } from "../src/db/client.js";
import { users, registrations, conclaves } from "../src/db/schema.js";
import { eq, and } from "drizzle-orm";
import { runAsSystem } from "../src/observability/context.js";

async function setupUser({
  email,
  password,
  name,
  phone,
  company,
  category,
  chapter,
  role,
}: {
  email: string;
  password: string;
  name: string;
  phone: string;
  company: string;
  category: string;
  chapter: string;
  role: "captain" | "member";
}) {
  let uid: string;
  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    await auth.updateUser(uid, {
      password,
      emailVerified: true,
      displayName: name,
    });
    console.log(`Updated Firebase auth for ${email} (${uid})`);
  } catch {
    const created = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: true,
    });
    uid = created.uid;
    console.log(`Created Firebase auth for ${email} (${uid})`);
  }

  // Upsert into users table
  await pgdb
    .insert(users)
    .values({
      uid,
      name,
      email,
      phone,
      company,
      category,
      chapter,
      role,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: {
        name,
        email,
        phone,
        company,
        category,
        chapter,
        role,
        updatedAt: new Date(),
      },
    });

  // Find active conclaves to register this user into
  const activeConclaves = await pgdb.select().from(conclaves);
  for (const c of activeConclaves) {
    const [existingReg] = await pgdb
      .select()
      .from(registrations)
      .where(and(eq(registrations.conclaveId, c.id), eq(registrations.userId, uid)));

    if (!existingReg) {
      await pgdb.insert(registrations).values({
        conclaveId: c.id,
        userId: uid,
        role,
        status: "confirmed",
        tableNumber: role === "captain" ? 1 : null,
      });
      console.log(`Registered ${name} as ${role} in conclave: ${c.name}`);
    } else {
      await pgdb
        .update(registrations)
        .set({ role, status: "confirmed", tableNumber: role === "captain" ? 1 : existingReg.tableNumber })
        .where(and(eq(registrations.conclaveId, c.id), eq(registrations.userId, uid)));
      console.log(`Updated registration for ${name} as ${role} in conclave: ${c.name}`);
    }
  }

  return { email, password, name, role };
}

async function run() {
  console.log("Setting up test accounts...\n");

  const captain = await setupUser({
    email: "captain@conclave.com",
    password: "Password123",
    name: "Sarah Captain",
    phone: "+919876500001",
    company: "Apex Global Solutions",
    category: "Financial Services",
    chapter: "Peak Performance",
    role: "captain",
  });

  const member = await setupUser({
    email: "member@conclave.com",
    password: "Password123",
    name: "John Member",
    phone: "+919876500002",
    company: "Elite Digital Media",
    category: "Digital Marketing",
    chapter: "Peak Performance",
    role: "member",
  });

  console.log("\nSetup complete!");
  console.log("Captain:", captain);
  console.log("Member:", member);
}

runAsSystem("setup-test-users", run, "script")
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("Error setting up test users:", err);
    await pool.end();
    process.exit(1);
  });
