import { db, collections } from "../config/firebase.js";
import { ConclaveStatus } from "../domain/conclave.js";
import { clearConclaveCache } from "./conclave.service.js";
import { getRoundTiming, type RoundTiming } from "./settings.service.js";

/**
 * Auto-completion sweep.
 *
 * Rounds now advance on the clock with no per-round admin action, so a conclave
 * also *finishes* on the clock. The member app derives that instantly for its
 * live view, but the STORED status must catch up too: the app reads the conclave
 * list straight from Firestore, and a finished conclave left as "running" would
 * linger in the "Live" list and block the organiser from starting the next event
 * (the concurrency guard treats it as still in progress). This is also the
 * durable fix for the "marked ended but still showing as ongoing" bug.
 *
 * No external cron — an in-process interval, like the 1-2-1 reminder scheduler.
 */

/** Round length, mirroring the app's RoundTiming (admin-tuned, auto-scaling, or a fixed override). */
function roundDurationMs(data: any, timing: RoundTiming): number {
  const p = Math.max(1, Number(data?.personsPerTable) || 1);
  const active = (timing.bioSeconds + timing.referralSeconds) * 1000 * p;
  const block = Number(data?.roundBlockMinutes);
  if (Number.isFinite(block) && block > 0) {
    return active + Math.max(0, block * 60 * 1000 - active);
  }
  return active + timing.bufferSeconds * 1000;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v?.toDate === "function") return v.toDate();
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "number") return new Date(v);
  return null;
}

/** Completes every running conclave whose rounds have all elapsed (or whose event day is past). Returns how many it closed. */
export async function sweepFinishedConclaves(): Promise<number> {
  const snap = await db
    .collection(collections.conclaves)
    .where("status", "==", ConclaveStatus.running)
    .get();

  const now = Date.now();
  const timing = await getRoundTiming(); // admin-tuned cadence; one read per sweep
  let completed = 0;

  for (const doc of snap.docs) {
    const d: any = doc.data();
    let done = false;

    const anchor = toDate(d.currentRoundStartedAt);
    const roundCount = Number(d.roundCount) || 0;
    if (anchor && roundCount > 0) {
      // The anchor is the start of the last-started round (round 1 in the normal
      // auto-advance flow); the rounds remaining from there are roundCount minus
      // that base plus one, so completion doesn't assume the anchor is round 1.
      const baseRound = Math.max(1, Number(d.currentRound) || 1);
      const remaining = Math.max(1, roundCount - baseRound + 1);
      const endsAt = anchor.getTime() + remaining * roundDurationMs(d, timing);
      if (now > endsAt) done = true;
    }

    // Belt and braces: an event whose whole day has passed is over regardless
    // of round bookkeeping (covers conclaves that never actually ran).
    if (!done) {
      const day = toDate(d.endDate) || toDate(d.date) || toDate(d.startDate);
      if (day) {
        const endOfDay = new Date(day);
        endOfDay.setHours(23, 59, 59, 999);
        if (now > endOfDay.getTime()) done = true;
      }
    }

    if (done) {
      await doc.ref.update({
        status: ConclaveStatus.completed,
        isRegistrationOpen: false,
        currentRound: roundCount > 0 ? roundCount : d.currentRound ?? 0,
        updatedAt: new Date(),
      });
      completed++;
    }
  }

  if (completed > 0) clearConclaveCache();
  return completed;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the periodic sweep (default every 60s). Idempotent. */
export function startAutoCompleteSweep(intervalMs = 60_000): void {
  if (timer) return;
  const tick = () =>
    sweepFinishedConclaves()
      .then((n) => {
        if (n > 0) console.log(`[autocomplete] completed ${n} finished conclave(s)`);
      })
      .catch((e) => console.error("[autocomplete] sweep failed:", e?.message || e));
  tick(); // run once at startup — also clears any stale 'running' left behind
  timer = setInterval(tick, intervalMs);
}
