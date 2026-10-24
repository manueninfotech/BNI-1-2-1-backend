import { eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { attendance, referrals, registrations } from "../db/schema.js";
import { tableCountFor } from "../engine/index.js";
import { ConclaveStatus, ROLE_LOCKED_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow, roundDurationMs } from "./conclave.service.js";
import { fetchUsers, isActiveUser, listRegistrants } from "./user.service.js";
import { getAutoLogoutHours, getRoundTiming } from "./settings.service.js";

/**
 * The live dashboard for one conclave (polled by the admin panel).
 *
 * Round timing comes from the admin-tuned settings — the same numbers the app
 * and the auto-complete sweep use, so the admin's countdown matches members'.
 * Errors surface as errors (with a request id) rather than a fake all-zero
 * dashboard that looks real.
 */
export async function conclaveStats(id: string) {
  const serverReceivedAt = Date.now();
  const { row: conclave } = await getConclaveOrThrow(id);

  const [autoLogoutHours, timing, regs, [{ refCount }], [{ attCount }]] = await Promise.all([
    getAutoLogoutHours(),
    getRoundTiming(),
    pgdb.select({ userId: registrations.userId, role: registrations.role }).from(registrations).where(eq(registrations.conclaveId, id)),
    pgdb.select({ refCount: sql<number>`count(*)::int` }).from(referrals).where(eq(referrals.conclaveId, id)),
    pgdb.select({ attCount: sql<number>`count(*)::int` }).from(attendance).where(eq(attendance.conclaveId, id)),
  ]);

  const users = await fetchUsers(regs.map((r) => r.userId));
  const now = new Date();
  const captains = regs.filter((r) => r.role === "captain").length;
  const active = regs.filter((r) => isActiveUser(users.get(r.userId), autoLogoutHours, now)).length;

  const personsPerTable = conclave.personsPerTable ?? 7;
  const roundMs = roundDurationMs(personsPerTable, timing, conclave.legacy?.roundBlockMinutes);
  const activeMs = (timing.bioSeconds + timing.referralSeconds) * 1000 * Math.max(1, personsPerTable);
  const transitionMs = Math.max(0, roundMs - activeMs);

  let startsAt: Date | null = conclave.startDate;
  const [hh, mm] = String(conclave.startTime ?? "").split(":");
  if (startsAt && hh && mm) {
    startsAt = new Date(startsAt);
    startsAt.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
  }

  let currentRoundEndsAt: string | null = null;
  let currentRoundComplete: boolean | null = null;
  if (conclave.status === ConclaveStatus.running && conclave.currentRoundStartedAt) {
    const endsAt = new Date(conclave.currentRoundStartedAt.getTime() + activeMs);
    currentRoundEndsAt = endsAt.toISOString();
    currentRoundComplete = now >= endsAt;
  }

  return {
    serverReceivedAt: new Date(serverReceivedAt).toISOString(),
    serverSentAt: new Date().toISOString(),
    conclaveId: id,
    name: conclave.name,
    status: conclave.status,
    personsPerTable,
    roundCount: conclave.roundCount ?? 0,
    currentRound: conclave.currentRound,
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
