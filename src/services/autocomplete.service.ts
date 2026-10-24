import { eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ConclaveStatus } from "../domain/conclave.js";
import { runAsSystem } from "../observability/context.js";
import { roundDurationMs } from "./conclave.service.js";
import { getRoundTiming } from "./settings.service.js";

/**
 * Auto-completion sweep.
 *
 * Rounds advance on the clock, so a conclave also finishes on the clock. The
 * STORED status must catch up, or a finished conclave lingers as "running" and
 * blocks the organiser from starting the next one.
 *
 * Safe with several server instances: rows are claimed with
 * FOR UPDATE SKIP LOCKED, so two instances never complete the same conclave.
 * Each completion is audited as a system action.
 */

type Row = typeof conclaves.$inferSelect;

/** Is this running conclave finished (all rounds elapsed, or its day has passed)? */
export function isFinished(
  row: Pick<Row, "currentRoundStartedAt" | "currentRound" | "roundCount" | "personsPerTable" | "startDate" | "endDate" | "legacy">,
  timing: Awaited<ReturnType<typeof getRoundTiming>>,
  now = Date.now(),
): boolean {
  const roundCount = row.roundCount ?? 0;
  if (row.currentRoundStartedAt && roundCount > 0) {
    // The anchor is the start of the last-started round; count rounds remaining from it.
    const baseRound = Math.max(1, row.currentRound || 1);
    const remaining = Math.max(1, roundCount - baseRound + 1);
    const endsAt =
      row.currentRoundStartedAt.getTime() + remaining * roundDurationMs(row.personsPerTable, timing, row.legacy?.roundBlockMinutes);
    if (now > endsAt) return true;
  }
  // Belt and braces: an event whose whole day has passed is over.
  const day = row.endDate ?? row.startDate;
  if (day) {
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);
    if (now > endOfDay.getTime()) return true;
  }
  return false;
}

/** Completes every finished running conclave. Returns how many it closed. */
export async function sweepFinishedConclaves(): Promise<number> {
  const timing = await getRoundTiming();
  return pgdb.transaction(async (tx) => {
    const running = await tx
      .select()
      .from(conclaves)
      .where(eq(conclaves.status, ConclaveStatus.running))
      .for("update", { skipLocked: true });

    let completed = 0;
    for (const row of running) {
      if (!isFinished(row, timing)) continue;
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
