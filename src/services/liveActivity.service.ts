import { and, eq, inArray, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, liveActivityTokens, registrations } from "../db/schema.js";
import { messaging } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import { liveActivityFor, liveActivityKey, type LiveActivityRow } from "../domain/liveActivityState.js";
import { runAsSystem } from "../observability/context.js";

/**
 * iOS Live Activity push updates (v2).
 *
 * The app registers its activity's push token here when a round's lock-screen
 * card starts. A small sweep watches conclaves that have registered cards and,
 * whenever the conclave-wide state changes (round start, referrals open, move
 * break, pause / resume, extra time, conclave end), pushes each member's new
 * card through FCM — so the card stays right while the app is suspended.
 *
 * Pushes go out only on changes (~4 per member per round), deduped across
 * instances by a compare-and-set on conclaves.live_activity_key.
 */

const clean = (v: unknown, max = 4096) => String(v ?? "").trim().slice(0, max);

/** Registers (or refreshes) this member's card for this conclave. */
export async function registerToken(conclaveId: string, uid: string, body: { pushToken?: unknown; fcmToken?: unknown }) {
  const pushToken = clean(body.pushToken, 512);
  const fcmToken = clean(body.fcmToken, 4096);
  if (!/^[0-9a-f]{32,}$/i.test(pushToken)) throw ApiError.badRequest("pushToken must be the activity's hex push token.");
  if (!fcmToken) throw ApiError.badRequest("fcmToken is required.");
  const [reg] = await pgdb
    .select({ u: registrations.userId })
    .from(registrations)
    .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
  if (!reg) throw ApiError.forbidden("You aren't registered for this conclave.");
  await pgdb
    .insert(liveActivityTokens)
    .values({ conclaveId, userId: uid, pushToken, fcmToken })
    .onConflictDoUpdate({
      target: [liveActivityTokens.conclaveId, liveActivityTokens.userId],
      set: { pushToken, fcmToken, updatedAt: new Date() },
    });
  return { ok: true };
}

export async function removeToken(conclaveId: string, uid: string) {
  await pgdb
    .delete(liveActivityTokens)
    .where(and(eq(liveActivityTokens.conclaveId, conclaveId), eq(liveActivityTokens.userId, uid)));
  return { ok: true };
}

const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** One sweep: push to every conclave whose state changed. Returns pushes sent. */
export async function sweepLiveActivities(now = Date.now()): Promise<number> {
  const ids = (await pgdb.selectDistinct({ id: liveActivityTokens.conclaveId }).from(liveActivityTokens)).map((r) => r.id);
  if (ids.length === 0) return 0;
  const rows = await pgdb.select().from(conclaves).where(inArray(conclaves.id, ids));
  let sent = 0;

  for (const c of rows) {
    const row = c as unknown as LiveActivityRow;
    const key = liveActivityKey(row, now);
    if (key === c.liveActivityKey) continue;

    // Compare-and-set: exactly one instance wins each change.
    const won = await pgdb
      .update(conclaves)
      .set({ liveActivityKey: key })
      .where(and(eq(conclaves.id, c.id), sql`${conclaves.liveActivityKey} IS DISTINCT FROM ${key}`))
      .returning({ id: conclaves.id });
    if (won.length === 0) continue;

    const tokens = await pgdb.select().from(liveActivityTokens).where(eq(liveActivityTokens.conclaveId, c.id));
    const jobs = tokens
      .map((t) => ({ t, update: liveActivityFor(row, t.userId, now) }))
      .filter((j): j is { t: (typeof tokens)[number]; update: NonNullable<ReturnType<typeof liveActivityFor>> } => j.update !== null);

    const ending = jobs.some((j) => j.update.event === "end") || c.status !== "running";
    const stamp = Math.floor(now / 1000);

    for (let i = 0; i < jobs.length; i += 500) {
      const batch = jobs.slice(i, i + 500);
      const res = await messaging.sendEach(
        batch.map(({ t, update }) => ({
          token: t.fcmToken,
          apns: {
            liveActivityToken: t.pushToken,
            headers: { "apns-priority": "10" },
            payload: {
              aps: {
                timestamp: stamp,
                event: update.event,
                "content-state": update.content,
                ...(update.event === "end" ? { "dismissal-date": stamp + 15 * 60 } : {}),
              },
            },
          },
        })),
      );
      sent += res.successCount;
      const dead = res.responses
        .map((r, k) => (!r.success && DEAD_TOKEN.has(r.error?.code ?? "") ? batch[k].t.userId : null))
        .filter((u): u is string => u !== null);
      if (dead.length) {
        await pgdb
          .delete(liveActivityTokens)
          .where(and(eq(liveActivityTokens.conclaveId, c.id), inArray(liveActivityTokens.userId, dead)));
      }
    }

    // The conclave is over: the cards have been told to end; forget them.
    if (ending) await pgdb.delete(liveActivityTokens).where(eq(liveActivityTokens.conclaveId, c.id));
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the sweep (every 5 s — phase changes reach the lock screen quickly). */
export function startLiveActivitySweep(intervalMs = 5_000): void {
  if (timer) return;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runAsSystem("live-activity-sweep", () => sweepLiveActivities())
      .then((n) => {
        if (n > 0) console.log(JSON.stringify({ level: "info", msg: "live activity pushes", count: n }));
      })
      .catch((e) => console.error(JSON.stringify({ level: "error", msg: "live activity sweep failed", err: (e as Error)?.message })))
      .finally(() => {
        busy = false;
      });
  };
  timer = setInterval(tick, intervalMs);
}
