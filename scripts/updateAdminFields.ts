import { auth, db, collections } from "../src/config/firebase.js";

async function run() {
  // Ensure superadmin@bni.com exists in auth and has a record in admins collection
  const superadminEmail = "superadmin@bni.com";
  let superadminUid: string;
  
  try {
    const user = await auth.getUserByEmail(superadminEmail);
    superadminUid = user.uid;
    console.log(`Superadmin user already exists (${superadminUid}).`);
  } catch {
    const user = await auth.createUser({
      email: superadminEmail,
      password: "passwrd",
      displayName: "Superadmin",
      emailVerified: true
    });
    superadminUid = user.uid;
    console.log(`Created Superadmin auth user: ${superadminUid}`);
  }

  // Set/update the superadmin document
  await db.collection(collections.admins).doc(superadminUid).set({
    email: superadminEmail,
    name: "Superadmin",
    region: "Global",
    mobile: "9876543210",
    status: "Active",
    role: "superadmin",
    grantedAt: new Date()
  }, { merge: true });
  console.log(`Superadmin database record updated.`);

  // Now inspect and update all other admins
  const snap = await db.collection(collections.admins).get();
  for (const doc of snap.docs) {
    if (doc.id === superadminUid) continue; // skip superadmin
    
    const data = doc.data();
    const email = data.email || "";
    const name = data.name || email.split('@')[0] || "Coordinator";
    const region = data.region || "Guntur Region";
    const status = data.status || "Active";
    const role = data.role || "coordinator";
    
    // Assign specific mobile numbers to known accounts
    let mobile = data.mobile || "";
    if (email === "eb@gmail.com") {
      mobile = "9876543211";
    } else if (email === "admin@bni.com") {
      mobile = "9876543212";
    } else if (!mobile) {
      mobile = "9876543213"; // fallback for any other admin without mobile
    }

    console.log(`Updating coordinator ${doc.id} (${email}):`, { name, region, mobile, status, role });
    
    await doc.ref.set({
      name,
      region,
      mobile,
      status,
      role
    }, { merge: true });
  }
}

run()
  .then(() => {
    console.log("Migration complete: all admin fields populated successfully.");
    process.exit(0);
  })
  .catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
