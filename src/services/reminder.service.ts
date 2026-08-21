import { db, collections } from "../config/firebase.js";
import { sendDataToUser } from "./notification.service.js";

const ONE_TO_ONES = "oneToOnes";

/** How far ahead of a meeting to fire the reminder. */
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function nameOf(uid: string): Promise<string> {
  try {
    const d = await db.collection(collections.users).doc(uid).get();
    return ((d.data() as any)?.name || "A member").toString();
  } catch {
    return "A member";
  }
}

/**
 * Fires the "your 1-2-1 is coming up" reminder for any accepted meeting that has
 * entered the next hour and hasn't been reminded yet. Marks each as reminded so
 * it goes out exactly once.
 *
 * Sends a DATA-only push so the app can raise a sticky notification with a live
 * countdown to the meeting time (the countdown ticks on the device — the server
 * doesn't push every second).
 */
export async function sweepOneToOneReminders(): Promise<void> {
  const now = Date.now();
  const snap = await db
    .collection(ONE_TO_ONES)
    .where("status", "==", "accepted")
    .get();

  const batch = db.batch();
  let sent = 0;

  for (const doc of snap.docs) {
    const m = doc.data() as any;
    if (m.reminderSent) continue;

    const at = Date.parse(m.proposedAt || "");
    if (Number.isNaN(at)) continue;
    // Only once the meeting is within the next hour, and not already past.
    if (at <= now || at - now > WINDOW_MS) continue;

    const proposedAt = new Date(at).toISOString();
    const [fromName, toName] = await Promise.all([
      nameOf(m.fromUserId),
      nameOf(m.toUserId),
    ]);
    const base = {
      type: "one_to_one_reminder",
      id: doc.id,
      proposedAt,
      location: (m.location || "").toString(),
    };

    await sendDataToUser(m.fromUserId, { ...base, otherName: toName });
    await sendDataToUser(m.toUserId, { ...base, otherName: fromName });

    batch.set(doc.ref, { reminderSent: true }, { merge: true });
    sent++;
  }

  if (sent > 0) {
    await batch.commit();
    console.log(`1-2-1 reminders sent: ${sent}`);
  }
}

/**
 * Starts the in-process reminder scheduler. Runs once on boot, then every few
 * minutes. (On a host that sleeps idle instances, keep it warm with an uptime
 * pinger, or move this to a dedicated cron service.)
 */
export function startReminderScheduler(): void {
  const run = () =>
    sweepOneToOneReminders().catch((e) =>
      console.error("1-2-1 reminder sweep failed:", (e as Error).message),
    );
  run();
  setInterval(run, 5 * 60 * 1000);
}
