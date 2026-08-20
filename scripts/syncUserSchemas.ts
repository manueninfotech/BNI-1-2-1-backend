import 'dotenv/config';
import fs from 'fs';
import path from 'path';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  const saPath = path.resolve(process.cwd(), 'firebase-service-account.json');
  if (fs.existsSync(saPath)) {
    process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(saPath, 'utf8');
  }
}

import { db, collections } from '../src/config/firebase.js';

async function syncUserSchemas() {
  console.log('Fetching all users from Firestore...');
  const snap = await db.collection(collections.users).get();

  if (snap.empty) {
    console.log('No users found in Firestore.');
    return;
  }

  console.log(`Found ${snap.size} user document(s). Syncing schemas for Mobile/Web cross-compatibility...\n`);

  let count = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const uid = doc.id;

    const rawPhone = String(data.phone || data.mobile || '').trim();
    let digitsOnly = rawPhone.replace(/\D/g, '');
    if (digitsOnly.length === 10) {
      digitsOnly = '91' + digitsOnly;
    }

    const formattedPhone = digitsOnly ? `+${digitsOnly}` : rawPhone;
    const rawMobile = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : rawPhone;
    const syntheticIdentifier = digitsOnly ? `${digitsOnly}@bni121.conclave` : data.identifier;

    const updates: Record<string, any> = {};

    if (!data.id) updates.id = uid;
    if (formattedPhone && data.phone !== formattedPhone) updates.phone = formattedPhone;
    if (rawMobile && data.mobile !== rawMobile) updates.mobile = rawMobile;
    if (syntheticIdentifier && data.identifier !== syntheticIdentifier) updates.identifier = syntheticIdentifier;

    const companyVal = data.company || data.businessName || '';
    if (companyVal) {
      if (!data.company) updates.company = companyVal;
      if (!data.businessName) updates.businessName = companyVal;
    }

    const catVal = data.category || data.businessCategory || '';
    if (catVal) {
      if (!data.category) updates.category = catVal;
      if (!data.businessCategory) updates.businessCategory = catVal;
    }

    const regVal = data.region || data.location || '';
    if (regVal) {
      if (!data.region) updates.region = regVal;
      if (!data.location) updates.location = String(regVal).toLowerCase();
    }

    if (!data.country) updates.country = 'India';

    if (Object.keys(updates).length > 0) {
      await doc.ref.update(updates);
      count++;
      console.log(`[${uid}] "${data.name || data.email}" patched with updates:`, updates);
    } else {
      console.log(`[${uid}] "${data.name || data.email}" already fully synchronized.`);
    }
  }

  console.log(`\nSuccessfully synchronized ${count} user document(s).`);
}

syncUserSchemas()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error syncing user schemas:', err);
    process.exit(1);
  });
