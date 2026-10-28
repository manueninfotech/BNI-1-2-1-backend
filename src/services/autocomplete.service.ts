import { eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ConclaveStatus } from "../domain/conclave.js";
import { runAsSystem } from "../observability/context.js";
import { liveClock, roundEndMs } from "../domain/roundClock.js";
import { notifyConclaveChanged } from "./live.service.js";

/**
 * Auto-completion sweep.
 *
 * A conclave is marked completed once its last round's time is over (the
 * admin can also mark it completed). The STORED status must catch up, or a
 * finished conclave lingers as "running" and blocks starting the next one.
 *
 * Safe with several server instances: rows are claimed with
 * FOR UPDATE SKIP LOCKED, so two instances never complete the same conclave.
 * Each completion is audited as a system action.
 */

type Row = typeof conclaves.$inferSelect;

/**
 * Is this running conclave finished? Yes once its LAST round's time (talk +
 * any extension) is over, with a minute's grace — in either mode. A paused
 * conclave never is. Safety net: a conclave started over 24 hours ago, or a
 * "running" one with no round anchor whose day has passed, is over too.
 */
export function isFinished(
  row: Pick<
    Row,
    | "currentRoundStartedAt"
    | "currentRound"
    | "roundCount"
    | "personsPerTable"
    | "startDate"
    | "endDate"
    | "isRoundPaused"
    | "roundElapsedMsBeforePause"
    | "roundProgressionMode"
    | "roundExtensionSeconds"
    | "moveSeconds"
  >,
  now = Date.now(),
): boolean {
  if (row.isRoundPaused) return false;
  if (row.currentRoundStartedAt) {
    const live = liveClock(row, now);
    if (live.phase === "done") {
      const ends = roundEndMs(row, live.round);
      if (ends !== null && now > ends + FINISH_GRACE_MS) return true;
    }
    return now - row.currentRoundStartedAt.getTime() > ABANDONED_AFTER_MS;
  }
  const day = row.endDate ?? row.startDate;
  if (day) {
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);
    if (now > endOfDay.getTime()) return true;
  }
  return false;
}

const FINISH_GRACE_MS = 60_000;
const ABANDONED_AFTER_MS = 24 * 60 * 60_000;

export async function sweepFinishedConclaves(): Promise<number> {
  return pgdb.transaction(async (tx) => {
    const running = await tx
      .select()
      .from(conclaves)
      .where(eq(conclaves.status, ConclaveStatus.running))
      .for("update", { skipLocked: true });

    let completed = 0;
    for (const row of running) {
      if (!isFinished(row)) continue;
      const [after] = await tx
        .update(conclaves)
        .set({
          status: ConclaveStatus.completed,
          isRegistrationOpen: false,
          currentRound: row.roundCount && row.roundCount > 0 ? row.roundCount : row.currentRound,
          updatedAt: sql`now()`,
        })
        .where(eq(conclaves.id, row.id))
        .returning();
      await audit.change(
        {
          action: "conclave.auto_complete",
          entityType: "conclave",
          entityId: row.id,
          conclaveId: row.id,
          before: { status: row.status, currentRound: row.currentRound },
          after: { status: after.status, currentRound: after.currentRound },
        },
        tx,
      );
      await notifyConclaveChanged(tx, row.id);
      completed++;
    }
    return completed;
  });
}

let timer: NodeJS.Timeout | null = null;

/** Starts the periodic sweep (default every 60s). Idempotent. */
export function startAutoCompleteSweep(intervalMs = 60_000): void {
  if (timer) return;
  const tick = () =>
    runAsSystem("autocomplete-sweep", sweepFinishedConclaves)
      .then((n) => {
        if (n > 0) console.log(JSON.stringify({ level: "info", msg: "autocomplete completed conclaves", count: n }));
      })
      .catch((e) => console.error(JSON.stringify({ level: "error", msg: "autocomplete sweep failed", err: (e as Error)?.message })));
  tick(); // once at startup — also clears any stale 'running' left behind
  timer = setInterval(tick, intervalMs);
}
