import { collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import {
  generateSchedule,
  validate,
  tableCountFor,
  type ConclaveConfig,
} from "../engine/index.js";
import { resolveCaptains, type ServerParticipant } from "../domain/captains.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";
import { fetchUsers, isActiveUser } from "./user.service.js";
import { getAutoLogoutHours } from "./settings.service.js";

export interface GenerateOptions {
  /**
   * Seat only ACTIVE users — the people actually in the room. The spec's
   * scenario: "out of 250 registered we got 200 as active users".
   */
  activeOnly?: boolean;

  /**
   * Let the system pick any captains the admin has not designated.
   *
   * OFF by default, deliberately. The system cannot know who should anchor a
   * table, so it refuses to invent captains unless explicitly told to.
   */
  autoFillCaptains?: boolean;
}

export async function generateForConclave(conclaveId: string, opts: GenerateOptions) {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);
  const ref = conclaveRef(conclaveId);

  const regsSnap = await ref.collection(collections.registrations).get();
  if (regsSnap.empty) throw ApiError.badRequest("No participants registered yet.");

  const activeOnly = opts.activeOnly === true;
  const [users, autoLogoutHours] = await Promise.all([
    fetchUsers(regsSnap.docs.map((d) => d.id)),
    getAutoLogoutHours(),
  ]);
  const now = new Date();

  // THE SNAPSHOT — frozen here, at generation time.
  const participants: ServerParticipant[] = [];
  const designatedCaptainIds: number[] = [];
  const skippedInactive: string[] = [];
  let nextId = 1;

  for (const regDoc of regsSnap.docs) {
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
      // Chapter is optional, and Firestore REJECTS undefined outright — this
      // whole object is written back to the conclave document, so an absent
      // chapter must become null.
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

  const personsPerTable = conclave.personsPerTable;

  // Captains. The admin designates them; we do not invent them.
  const tablesRequired = tableCountFor(participants.length, personsPerTable);
  if (!opts.autoFillCaptains && designatedCaptainIds.length !== tablesRequired) {
    const diff = Math.abs(designatedCaptainIds.length - tablesRequired);
    const fix =
      designatedCaptainIds.length < tablesRequired
        ? `Designate ${diff} more captain(s).`
        : `Remove ${diff} captain(s), or lower persons-per-table.`;

    throw ApiError.badRequest(
      `This conclave needs exactly ${tablesRequired} captains (one per table) but ` +
        `${designatedCaptainIds.length} are designated. ${fix}`,
      {
        captainsRequired: tablesRequired,
        captainsDesignated: designatedCaptainIds.length,
        hint: "Re-send with autoFillCaptains: true to let the system choose the remainder.",
      },
    );
  }

  // The seed is persisted so the same roster + config reproduces the same
  // schedule — reproducible, auditable, re-runnable (spec §7.2).
  const seed: number = typeof conclave.seed === "number" ? conclave.seed : Date.now();

  const captainIds = resolveCaptains(
    participants,
    designatedCaptainIds,
    personsPerTable,
    seed,
  );

  const config: ConclaveConfig = {
    personsPerTable,
    roundCount: conclave.roundCount,
    seed,
  };

  // The validation gate (V1-V12). Hard failures mean no valid schedule EXISTS —
  // generating anyway would either throw deep in the matcher or emit a schedule
  // that violates the diversity rule.
  const validation = validate(participants, captainIds, config);
  if (!validation.ok) {
    throw ApiError.badRequest("Validation failed. Cannot generate a schedule.", {
      issues: validation.errors,
      warnings: validation.warnings,
      derived: validation.derived,
    });
  }

  // The gate is necessary but not sufficient: the matcher is a greedy heuristic,
  // so a roster that passes V1-V11 can still be unseatable — most often when the
  // participant count is an exact multiple of persons-per-table, leaving zero
  // spare seats to manoeuvre in. Surface that as guidance, not a 500.
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

  await ref.update({
    seed,
    schedule,
    participants,
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

  // Write every resolved role back — not just promotions. A designated captain
  // who got trimmed must be demoted, or the app would show them a captain view
  // for a table they don't anchor.
  const captainSet = new Set(captainIds);
  const tableOfCaptain = new Map<number, number>();
  for (const t of schedule.rounds[0]?.tables ?? []) {
    tableOfCaptain.set(t.captainId, t.tableNumber);
  }

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
