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

  const [conclaveDoc, autoLogoutHours, regsSnap, referralsCount, attendanceCount] =
    await Promise.all([
      ref.get(),
      getAutoLogoutHours(),
      ref.collection(collections.registrations).get(),
      ref.collection(collections.referrals).count().get(),
      ref.collection(collections.attendance).count().get(),
    ]);

  if (!conclaveDoc.exists) {
    const { data } = await getConclaveOrThrow(id); // throws 404
    void data;
  }
  const conclave = conclaveDoc.data()!;

  const users = await fetchUsers(regsSnap.docs.map((d) => d.id));
  const now = new Date();

  let active = 0;
  let captains = 0;
  for (const doc of regsSnap.docs) {
    if (doc.data().role === "captain") captains++;
    if (isActiveUser(users.get(doc.id), autoLogoutHours, now)) active++;
  }

  const total = regsSnap.size;
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
    // Lets the caller correct for its own clock drift. See sync.service.
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
      referrals: referralsCount.data().count,
      attendanceRecords: attendanceCount.data().count,
    },
  };
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
