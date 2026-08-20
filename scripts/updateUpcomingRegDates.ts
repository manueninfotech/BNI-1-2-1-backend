import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Ensure FIREBASE_SERVICE_ACCOUNT is set before loading firebase config
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  const saPath = path.resolve(process.cwd(), 'firebase-service-account.json');
  if (fs.existsSync(saPath)) {
    process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(saPath, 'utf8');
  }
}

import { db, collections } from '../src/config/firebase.js';
import { evaluateConclaveStatus } from '../src/services/conclave.service.js';

async function updateUpcomingRegDates() {
  console.log('Fetching conclaves from Firestore...');
  const snap = await db.collection(collections.conclaves).get();

  if (snap.empty) {
    console.log('No conclaves found in Firestore.');
    return;
  }

  // Today is August 20, 2026
  const today = new Date();
  console.log(`Current local execution date: ${today.toISOString()}`);
  console.log(`Found ${snap.size} total conclaves.\n`);

  let count = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const id = doc.id;
    const name = data.name || data.title || 'Untitled Conclave';
    const status = (data.status || '').toLowerCase();

    // Check if event is completed/cancelled
    const isTerminal = ['completed', 'finished', 'ended', 'cancelled'].includes(status);

    if (!isTerminal) {
      console.log(`[${id}] "${name}" (current status: ${data.status})`);

      // Set registration start date to today's start of day
      const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      // Ensure event date exists
      let eventDate = data.date ? (data.date.toDate ? data.date.toDate() : new Date(data.date)) : null;
      if (!eventDate || Number.isNaN(eventDate.getTime())) {
        // Default event date to 14 days from today if missing
        eventDate = new Date(today.valueOf() + 14 * 24 * 60 * 60 * 1000);
      }

      // Default registration end date to day before event date if missing
      let regEndDate = data.regEndDate ? (data.regEndDate.toDate ? data.regEndDate.toDate() : new Date(data.regEndDate)) : null;
      if (!regEndDate || Number.isNaN(regEndDate.getTime())) {
        regEndDate = new Date(eventDate.valueOf() - 1 * 24 * 60 * 60 * 1000);
      }

      const updatedData = {
        ...data,
        regStartDate: todayDateOnly,
        date: eventDate,
        regEndDate: regEndDate,
      };

      const evalResult = evaluateConclaveStatus(updatedData);

      const updates: Record<string, any> = {
        regStartDate: todayDateOnly,
        date: eventDate,
        regEndDate: regEndDate,
        updatedAt: today,
        status: evalResult.status,
        isRegistrationOpen: evalResult.isRegistrationOpen,
      };

      await doc.ref.update(updates);
      count++;
      console.log(`  -> Updated regStartDate to today (${todayDateOnly.toISOString().slice(0, 10)}) | Event Date: ${eventDate.toISOString().slice(0, 10)} | Status: ${updates.status} | Reg Open: ${updates.isRegistrationOpen}`);
    } else {
      console.log(`[${id}] "${name}" is completed/cancelled (${status}), skipped.`);
    }
  }

  console.log(`\nSuccessfully updated registration start date to today for ${count} upcoming conclave(s).`);
}

updateUpcomingRegDates()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error updating conclaves:', err);
    process.exit(1);
  });
