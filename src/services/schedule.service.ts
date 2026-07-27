import { collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import {
  generateSchedule,
  validate,
  tableCountFor,
  type ConclaveConfig,
} from "../engine/index.js";
import { resolveCaptains, type ServerParticipant } from "../domain/captains.js";
import { getConclaveOrThrow, conclaveRef, validateConfig, clearConclaveCache, evaluateConclaveStatus } from "./conclave.service.js";
import { fetchUsers, isActiveUser } from "./user.service.js";
import { getAutoLogoutHours } from "./settings.service.js";

export interface GenerateOptions {
  /**
   * Seat only ACTIVE users — the people actually in the room.
   */
  activeOnly?: boolean;

  /**
   * Let the system pick any captains the admin has not designated.
   */
  autoFillCaptains?: boolean;
  personsPerTable?: number;
  roundCount?: number;
}

export async function generateForConclave(conclaveId: string, opts: GenerateOptions) {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);
  const ref = conclaveRef(conclaveId);

  const snap = await ref.collection(collections.registrations).get();
  if (snap.empty) {
    throw ApiError.badRequest("No registrations found for this conclave.");
  }

  const regsSnapDocs = snap.docs;
  const activeOnly = opts.activeOnly === true;
  const participants: ServerParticipant[] = [];
  const designatedCaptainIds: number[] = [];
  const skippedInactive: string[] = [];
  let nextId = 1;

  const [users, autoLogoutHours] = await Promise.all([
    fetchUsers(regsSnapDocs.map((d) => d.id)),
    getAutoLogoutHours(),
  ]);
  const now = new Date();

  for (const regDoc of regsSnapDocs) {
    const u = users.get(regDoc.id);
    if (!u) continue;

    if (activeOnly && !isActiveUser(u, autoLogoutHours, now)) {
      skippedInactive.push(u.name || regDoc.id);
      continue;
    }

    const id = nextId++;
    participants.push({
      id,
      name: u.name ?? "",
      phone: u.phone ?? "",
      businessName: u.businessName ?? "",
      businessCategory: u.businessCategory || "Uncategorized",
      location: (u.location ?? { withinGuntur: true }) as never,
      chapter: u.chapter ?? null,
      _originalUid: regDoc.id,
    } as ServerParticipant);

    if (regDoc.data().role === "captain") designatedCaptainIds.push(id);
  }

  if (participants.length === 0) {
    throw ApiError.badRequest(
      activeOnly
        ? "No active participants. Everyone registered has been auto-logged-out, so there is nobody to seat."
        : "No participants registered yet.",
    );
  }

  let personsPerTable = conclave.personsPerTable || 7;
  let roundCount = conclave.roundCount || 4;

  if (opts.personsPerTable !== undefined || opts.roundCount !== undefined) {
    personsPerTable = opts.personsPerTable ?? conclave.personsPerTable ?? 7;
    roundCount = opts.roundCount ?? conclave.roundCount ?? 4;
    validateConfig(personsPerTable, roundCount);
    await ref.update({ personsPerTable, roundCount });
  }

  const tablesRequired = tableCountFor(participants.length, personsPerTable);

  const hasDesignatedCaptains = designatedCaptainIds.length > 0;
  const shouldSkipCaptainCheck = opts.autoFillCaptains && !hasDesignatedCaptains;

  if (!shouldSkipCaptainCheck && designatedCaptainIds.length !== tablesRequired) {
    const diff = Math.abs(designatedCaptainIds.length - tablesRequired);
    const fix =
      designatedCaptainIds.length < tablesRequired
        ? `Promote ${diff} more member(s) to Table Captain in the Members page.`
        : `Demote ${diff} captain(s) to member, or increase persons-per-table.`;

    throw ApiError.badRequest(
      `This conclave needs exactly ${tablesRequired} table captains (one per table for ${participants.length} members @ ${personsPerTable}/table) ` +
        `but ${designatedCaptainIds.length} are currently designated. ${fix}`,
      {
        captainsRequired: tablesRequired,
        captainsDesignated: designatedCaptainIds.length,
        membersTotal: participants.length,
        personsPerTable,
        hint:
          designatedCaptainIds.length === 0
            ? "Go to the Members page and promote members to Table Captain first."
            : fix,
      },
    );
  }

  const seed: number = typeof conclave.seed === "number" ? conclave.seed : Date.now();

  const captainIds = resolveCaptains(
    participants,
    designatedCaptainIds,
    personsPerTable,
    seed,
  );

  const config: ConclaveConfig = {
    personsPerTable,
    roundCount,
    seed,
  };

  const validation = validate(participants, captainIds, config);
  if (!validation.ok) {
    throw ApiError.badRequest("Validation failed. Cannot generate a schedule.", {
      issues: validation.errors,
      warnings: validation.warnings,
      derived: validation.derived,
    });
  }

  let schedule;
  try {
    schedule = generateSchedule(participants, captainIds, config);
  } catch (e) {
    if ((e as Error).name === "InfeasibleRoundError") {
      throw ApiError.badRequest(
        "The roster passed validation but no category-safe seating exists for it. " +
          "Try changing persons-per-table (an exact fit with no spare seats is the usual cause), " +
          "or reduce the over-represented business categories.",
        { detail: (e as Error).message, derived: validation.derived },
      );
    }
    throw e;
  }

  const evalResult = evaluateConclaveStatus(conclave);

  await ref.update({
    seed,
    schedule,
    participants,
    status: evalResult.status,
    isRegistrationOpen: evalResult.isRegistrationOpen,
    scheduleSummary: {
      tableCount: schedule.tableCount,
      coverage: schedule.stats.coverage,
      repeatPairings: schedule.stats.repeatPairings,
    },
    warnings: validation.warnings,
    snapshot: {
      activeOnly,
      takenAt: new Date(),
      participantCount: participants.length,
      skippedInactiveCount: skippedInactive.length,
    },
  });

  const captainSet = new Set(captainIds);
  const tableOfCaptain = new Map<number, number>();
  for (const t of schedule.rounds[0]?.tables ?? []) {
    tableOfCaptain.set(t.captainId, t.tableNumber);
  }

  try {
    const batch = ref.firestore.batch();
    for (const p of participants) {
      const isCaptain = captainSet.has(p.id);
      batch.update(
        ref.collection(collections.registrations).doc(p._originalUid),
        {
          role: isCaptain ? "captain" : "member",
          participantId: p.id,
          tableNumber: isCaptain ? (tableOfCaptain.get(p.id) ?? null) : null,
        },
      );
    }
    await batch.commit();
  } catch {}

  clearConclaveCache();

  return {
    tableCount: schedule.tableCount,
    captains: captainIds.length,
    participants: participants.length,
    activeOnly,
    skippedInactiveCount: skippedInactive.length,
    warnings: validation.warnings,
    stats: schedule.stats,
  };
}
