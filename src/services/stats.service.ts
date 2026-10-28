import { eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { attendance, referrals, registrations } from "../db/schema.js";
import { tableCountFor } from "../engine/index.js";
import { ConclaveStatus, ROLE_LOCKED_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow } from "./conclave.service.js";
import { DEFAULT_MOVE_SECONDS, liveClock, phases, roundEndMs } from "../domain/roundClock.js";
import { fetchUsers, isActiveUser, listRegistrants } from "./user.service.js";
import { getAutoLogoutHours } from "./settings.service.js";

/**
 * The live dashboard for one conclave (polled by the admin panel).
 *
 * Round timing comes from the shared round clock — the same numbers the app
 * and the auto-complete sweep use, so the admin's countdown matches members'.
 * Errors surface as errors (with a request id) rather than a fake all-zero
 * dashboard that looks real.
 */
export async function conclaveStats(id: string) {
  const serverReceivedAt = Date.now();
  const { row: conclave } = await getConclaveOrThrow(id);

  const [autoLogoutHours, regs, [{ refCount }], [{ attCount }]] = await Promise.all([
    getAutoLogoutHours(),
    pgdb.select({ userId: registrations.userId, role: registrations.role }).from(registrations).where(eq(registrations.conclaveId, id)),
    pgdb.select({ refCount: sql<number>`count(*)::int` }).from(referrals).where(eq(referrals.conclaveId, id)),
    pgdb.select({ attCount: sql<number>`count(*)::int` }).from(attendance).where(eq(attendance.conclaveId, id)),
  ]);

  const users = await fetchUsers(regs.map((r) => r.userId));
  const now = new Date();
  const captains = regs.filter((r) => r.role === "captain").length;
  const active = regs.filter((r) => isActiveUser(users.get(r.userId), autoLogoutHours, now)).length;

  const personsPerTable = conclave.personsPerTable ?? 7;
  const activeMs = phases({ personsPerTable }).talkMs;
  const transitionMs = (conclave.moveSeconds ?? DEFAULT_MOVE_SECONDS) * 1000;

  let startsAt: Date | null = conclave.startDate;
  const [hh, mm] = String(conclave.startTime ?? "").split(":");
  if (startsAt && hh && mm) {
    startsAt = new Date(startsAt);
    startsAt.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
  }

  let currentRoundEndsAt: string | null = null;
  let currentRoundComplete: boolean | null = null;
  const clock = liveClock(conclave, now.getTime());
  if (conclave.status === ConclaveStatus.running && clock.round > 0) {
    const endsAt = new Date(roundEndMs(conclave, clock.round) ?? now.getTime());
    currentRoundEndsAt = endsAt.toISOString();
    currentRoundComplete = ["move", "waiting", "done"].includes(clock.phase);
  }

  return {
    serverReceivedAt: new Date(serverReceivedAt).toISOString(),
    serverSentAt: new Date().toISOString(),
    conclaveId: id,
    name: conclave.name,
    status: conclave.status,
    personsPerTable,
    roundCount: conclave.roundCount ?? 0,
    currentRound: clock.round || conclave.currentRound,
    roundPhase: clock.phase,
    autoLogoutHours,
    startsAt: startsAt?.toISOString() ?? null,
    currentRoundStartedAt: conclave.currentRoundStartedAt?.toISOString() ?? null,
    currentRoundEndsAt,
    currentRoundComplete,
    roundActiveMs: activeMs,
    roundTransitionMs: transitionMs,
    counts: {
      registered: regs.length,
      active,
      captains,
      members: regs.length - captains,
      referrals: refCount,
      attendanceRecords: attCount,
    },
  };
}

/** Registrants plus the captain arithmetic the admin needs to act on. */
export async function registrationsWithCounts(id: string) {
  const { row: conclave } = await getConclaveOrThrow(id);
  const [list, autoLogoutHours] = await Promise.all([listRegistrants(id), getAutoLogoutHours()]);
  const captainsDesignated = list.filter((r) => r.role === "captain").length;
  const activeCount = list.filter((r) => r.isActive).length;
  const personsPerTable = conclave.personsPerTable ?? 7;

  return {
    conclaveId: id,
    status: conclave.status,
    rolesLocked: ROLE_LOCKED_STATUSES.has(conclave.status),
    personsPerTable,
    autoLogoutHours,
    registrations: list,
    counts: {
      total: list.length,
      active: activeCount,
      captainsDesignated,
      members: list.length - captainsDesignated,
      // T = ceil(A / P): one captain per table; shrinks if only active users are seated.
      captainsRequired: tableCountFor(list.length, personsPerTable),
      captainsRequiredIfActiveOnly: tableCountFor(activeCount, personsPerTable),
    },
  };
}
