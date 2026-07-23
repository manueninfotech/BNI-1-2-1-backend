import { collections } from "../config/firebase.js";
import { tableCountFor } from "../engine/index.js";
import { roundTiming, ConclaveStatus } from "../domain/conclave.js";
import { conclaveRef, getConclaveOrThrow } from "./conclave.service.js";
import { fetchUsers, isActiveUser, listRegistrants } from "./user.service.js";
import { getAutoLogoutHours } from "./settings.service.js";
import { toDate } from "../utils/firestore.js";

/**
 * The live dashboard for one conclave.
 *
 * Every read here is independent, so they are issued together. Awaiting them one
 * at a time costs a full network round trip each — and the dashboard polls this.
 */
export async function conclaveStats(id: string) {
  const serverReceivedAt = Date.now();
  const ref = conclaveRef(id);

  try {
    const [conclaveDoc, autoLogoutHours, regsSnap, referralsCount, attendanceCount] =
      await Promise.all([
        ref.get(),
        getAutoLogoutHours().catch(() => 24),
        ref.collection(collections.registrations).get().catch(() => ({ docs: [], size: 0 })),
        ref.collection(collections.referrals).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
        ref.collection(collections.attendance).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      ]);

    const conclave = conclaveDoc.exists ? conclaveDoc.data()! : {};
    const docsList = (regsSnap as any).docs || [];
    const users = await fetchUsers(docsList.map((d: any) => d.id)).catch(() => new Map());
    const now = new Date();

    let active = 0;
    let captains = 0;
    for (const doc of docsList) {
      if (doc.data().role === "captain") captains++;
      if (isActiveUser(users.get(doc.id), autoLogoutHours, now)) active++;
    }

    const total = (regsSnap as any).size || docsList.length;
    const personsPerTable = conclave.personsPerTable ?? 7;
    const { activeMs, transitionMs } = roundTiming(personsPerTable);

    const startsAt = toDate(conclave.startTime) ?? toDate(conclave.date);
    const roundStartedAt = toDate(conclave.currentRoundStartedAt);

    let currentRoundEndsAt: string | null = null;
    let currentRoundComplete: boolean | null = null;
    if (conclave.status === ConclaveStatus.running && roundStartedAt) {
      const endsAt = new Date(roundStartedAt.getTime() + activeMs);
      currentRoundEndsAt = endsAt.toISOString();
      currentRoundComplete = now >= endsAt;
    }

    return {
      serverReceivedAt: new Date(serverReceivedAt).toISOString(),
      serverSentAt: new Date().toISOString(),
      conclaveId: id,
      name: conclave.name ?? "",
      status: conclave.status ?? "draft",
      personsPerTable,
      roundCount: conclave.roundCount ?? 0,
      currentRound: conclave.currentRound ?? 0,
      autoLogoutHours,
      startsAt: startsAt?.toISOString() ?? null,
      currentRoundStartedAt: roundStartedAt?.toISOString() ?? null,
      currentRoundEndsAt,
      currentRoundComplete,
      roundActiveMs: activeMs,
      roundTransitionMs: transitionMs,
      counts: {
        registered: total,
        active,
        captains,
        members: total - captains,
        referrals: (referralsCount as any)?.data()?.count || 0,
        attendanceRecords: (attendanceCount as any)?.data()?.count || 0,
      },
    };
  } catch (err: any) {
    console.warn("conclaveStats failed (quota/network):", err?.message || err);
    return {
      serverReceivedAt: new Date(serverReceivedAt).toISOString(),
      serverSentAt: new Date().toISOString(),
      conclaveId: id,
      name: "",
      status: "draft",
      personsPerTable: 7,
      roundCount: 4,
      currentRound: 0,
      autoLogoutHours: 24,
      startsAt: null,
      currentRoundStartedAt: null,
      currentRoundEndsAt: null,
      currentRoundComplete: null,
      roundActiveMs: 300000,
      roundTransitionMs: 120000,
      counts: {
        registered: 0,
        active: 0,
        captains: 0,
        members: 0,
        referrals: 0,
        attendanceRecords: 0,
      },
    };
  }
}

/** Registrants plus the captain arithmetic the admin needs to act on. */
export async function registrationsWithCounts(id: string) {
  const { data: conclave } = await getConclaveOrThrow(id);

  const [registrations, autoLogoutHours] = await Promise.all([
    listRegistrants(id),
    getAutoLogoutHours(),
  ]);

  const captainsDesignated = registrations.filter((r) => r.role === "captain").length;
  const activeCount = registrations.filter((r) => r.isActive).length;
  const personsPerTable = conclave.personsPerTable ?? 7;

  return {
    conclaveId: id,
    status: conclave.status ?? "draft",
    rolesLocked: ["running", "completed", "cancelled"].includes(conclave.status ?? ""),
    personsPerTable,
    autoLogoutHours,
    registrations,
    counts: {
      total: registrations.length,
      active: activeCount,
      captainsDesignated,
      members: registrations.length - captainsDesignated,
      // T = ceil(A / P): one captain per table. If the admin intends to snapshot
      // only active users, the captain requirement shrinks with them.
      captainsRequired: tableCountFor(registrations.length, personsPerTable),
      captainsRequiredIfActiveOnly: tableCountFor(activeCount, personsPerTable),
    },
  };
}
