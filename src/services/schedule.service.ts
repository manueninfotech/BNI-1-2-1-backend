import { and, eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, registrations } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { generateSchedule, validate, tableCountFor, type ConclaveConfig } from "../engine/index.js";
import { resolveCaptains, type ServerParticipant } from "../domain/captains.js";
import { ROLE_LOCKED_STATUSES } from "../domain/conclave.js";
import { validateConfig, evaluateConclaveStatus, toView } from "./conclave.service.js";
import { fetchUsers, isActiveUser } from "./user.service.js";
import { getAutoLogoutHours, getConclaveDefaults } from "./settings.service.js";
import { notifyConclaveChanged } from "./live.service.js";

export interface GenerateOptions {
  /** Seat only ACTIVE users — the people actually in the room. */
  activeOnly?: boolean;
  /** Let the system pick any captains the admin has not designated. */
  autoFillCaptains?: boolean;
  personsPerTable?: number;
  roundCount?: number;
  roundDurationMinutes?: number;
}

/**
 * Generates (or regenerates) the seating schedule.
 *
 * The conclave's config, the schedule, and every registrant's resulting role /
 * participant id / captain table are written in ONE transaction with the
 * conclave row locked, plus an audit change summarising the result — so a
 * failure can't leave the schedule and the roster disagreeing.
 */
export async function generateForConclave(conclaveId: string, opts: GenerateOptions) {
  const autoLogoutHours = await getAutoLogoutHours();

  return pgdb.transaction(async (tx) => {
    const [conclave] = await tx.select().from(conclaves).where(eq(conclaves.id, conclaveId)).for("update");
    if (!conclave) throw ApiError.notFound("Conclave not found.");
    if (ROLE_LOCKED_STATUSES.has(conclave.status)) {
      throw ApiError.conflict(`The schedule can't be regenerated once the conclave is ${conclave.status} — roles are frozen.`);
    }

    const regs = await tx.select().from(registrations).where(eq(registrations.conclaveId, conclaveId));
    if (regs.length === 0) throw ApiError.badRequest("No registrations found for this conclave.");

    const activeOnly = opts.activeOnly === true;
    const users = await fetchUsers(regs.map((r) => r.userId));
    const now = new Date();
    const participants: ServerParticipant[] = [];
    const designatedCaptainIds: number[] = [];
    let skippedInactive = 0;
    let nextId = 1;

    for (const reg of regs) {
      const u = users.get(reg.userId);
      if (!u) continue;
      if (activeOnly && !isActiveUser(u, autoLogoutHours, now)) {
        skippedInactive++;
        continue;
      }
      const id = nextId++;
      participants.push({
        id,
        name: u.name ?? "",
        phone: u.phone ?? "",
        businessName: u.company ?? "",
        businessCategory: u.category || "Uncategorized",
        location: (u.location ?? { withinGuntur: true }) as never,
        chapter: u.chapter ?? null,
        _originalUid: reg.userId,
      } as ServerParticipant);
      if (reg.role === "captain") designatedCaptainIds.push(id);
    }

    if (participants.length === 0) {
      throw ApiError.badRequest(
        activeOnly
          ? "No active participants. Everyone registered has been auto-logged-out, so there is nobody to seat."
          : "No participants registered yet.",
      );
    }

    const defaults = await getConclaveDefaults();
    let personsPerTable = conclave.personsPerTable || defaults.personsPerTable;
    let roundCount = conclave.roundCount || defaults.roundCount;
    const roundDurationMinutes =
      typeof opts.roundDurationMinutes === "number" && opts.roundDurationMinutes > 0
        ? opts.roundDurationMinutes
        : (conclave.roundDurationMinutes || defaults.roundDurationMinutes);
    if (opts.personsPerTable !== undefined || opts.roundCount !== undefined) {
      personsPerTable = Number(opts.personsPerTable ?? personsPerTable);
      roundCount = Number(opts.roundCount ?? roundCount);
      validateConfig(personsPerTable, roundCount);
    }

    const tablesRequired = tableCountFor(participants.length, personsPerTable);
    const skipCaptainCheck = opts.autoFillCaptains && designatedCaptainIds.length === 0;
    if (!skipCaptainCheck && designatedCaptainIds.length < tablesRequired) {
      const diff = tablesRequired - designatedCaptainIds.length;
      const fix = `Promote ${diff} more member(s) to Table Captain in the Members page.`;
      throw ApiError.badRequest(
        `This conclave needs at least ${tablesRequired} table captains (one per table for ${participants.length} members @ ${personsPerTable}/table) ` +
          `but only ${designatedCaptainIds.length} are currently designated. ${fix}`,
        {
          captainsRequired: tablesRequired,
          captainsDesignated: designatedCaptainIds.length,
          membersTotal: participants.length,
          personsPerTable,
          hint: designatedCaptainIds.length === 0 ? "Go to the Members page and promote members to Table Captain first." : fix,
        },
      );
    }

    const seed = typeof conclave.seed === "number" ? conclave.seed : Date.now();
    const captainIds = resolveCaptains(participants, designatedCaptainIds, personsPerTable, seed);
    const config: ConclaveConfig = { personsPerTable, roundCount, seed };

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

    const evaluated = evaluateConclaveStatus(toView(conclave));
    const scheduleSummary = {
      tableCount: schedule.tableCount,
      coverage: schedule.stats.coverage,
      repeatPairings: schedule.stats.repeatPairings,
    };
    const [after] = await tx
      .update(conclaves)
      .set({
        personsPerTable,
        roundCount,
        roundDurationMinutes,
        seed,
        schedule: schedule as unknown as Record<string, unknown>,
        participants,
        status: evaluated.status,
        isRegistrationOpen: evaluated.isRegistrationOpen,
        scheduleSummary,
        warnings: validation.warnings,
        snapshot: { activeOnly, takenAt: new Date().toISOString(), participantCount: participants.length, skippedInactiveCount: skippedInactive },
        updatedAt: new Date(),
      })
      .where(eq(conclaves.id, conclaveId))
      .returning();

    // Roster follows the schedule: captain/member, participant id, captain's table.
    const captainSet = new Set(captainIds);
    const tableOfCaptain = new Map<number, number>();
    for (const t of schedule.rounds[0]?.tables ?? []) tableOfCaptain.set(t.captainId, t.tableNumber);
    let rolesChanged = 0;
    for (const p of participants) {
      const isCaptain = captainSet.has(p.id);
      const reg = regs.find((r) => r.userId === p._originalUid);
      const role = isCaptain ? "captain" : "member";
      if (reg && reg.role !== role) rolesChanged++;
      await tx
        .update(registrations)
        .set({ role, participantId: p.id, tableNumber: isCaptain ? tableOfCaptain.get(p.id) ?? null : null })
        .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, p._originalUid)));
    }

    await audit.change(
      {
        action: "schedule.generate",
        entityType: "conclave",
        entityId: conclaveId,
        conclaveId,
        before: { personsPerTable: conclave.personsPerTable, roundCount: conclave.roundCount, seed: conclave.seed, scheduleSummary: conclave.scheduleSummary },
        after: { personsPerTable: after.personsPerTable, roundCount: after.roundCount, seed: after.seed, scheduleSummary },
        metadata: {
          regenerated: !!conclave.schedule,
          participants: participants.length,
          captains: captainIds.length,
          autoFilledCaptains: captainIds.filter((id) => !designatedCaptainIds.includes(id)).length,
          rolesChanged,
          activeOnly,
          skippedInactive,
          warnings: validation.warnings.length,
        },
      },
      tx,
    );

    await notifyConclaveChanged(tx, conclaveId);
    return {
      tableCount: schedule.tableCount,
      captains: captainIds.length,
      participants: participants.length,
      activeOnly,
      skippedInactiveCount: skippedInactive,
      warnings: validation.warnings,
      stats: schedule.stats,
    };
  });
}
