// The validation gate from the spec (§6). Runs BEFORE schedule generation.
// Hard checks (errors) block generation; warnings are advisory.

import {
  type ConclaveConfig,
  type Participant,
  type ValidationIssue,
  type ValidationResult,
  DEFAULT_LIMITS,
} from "./types.js";

export function tableCountFor(activeCount: number, personsPerTable: number): number {
  if (personsPerTable <= 0) return 0;
  return Math.ceil(activeCount / personsPerTable);
}

export function validate(
  participants: Participant[],
  captainIds: number[],
  config: ConclaveConfig,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string) =>
    errors.push({ code, message, severity: "error" });
  const warn = (code: string, message: string) =>
    warnings.push({ code, message, severity: "warning" });

  const P = config.personsPerTable;
  const R = config.roundCount;
  const A = participants.length;
  const T = tableCountFor(A, P);
  const minRounds = config.minRounds ?? DEFAULT_LIMITS.minRounds;
  const maxRounds = config.maxRounds ?? DEFAULT_LIMITS.maxRounds;
  const captainSet = new Set(captainIds);

  // --- 6.1 Data integrity ---------------------------------------------------
  // V1: every participant has a non-empty business category.
  const missingCategory = participants.filter((p) => !p.businessCategory?.trim());
  if (missingCategory.length > 0) {
    err("V1", `${missingCategory.length} participant(s) missing a business category.`);
  }
  // V2: unique ids.
  const idCounts = new Map<number, number>();
  for (const p of participants) idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);
  const dupIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  if (dupIds.length > 0) {
    err("V2", `Duplicate participant id(s): ${dupIds.join(", ")}.`);
  }
  // V3: captain ids must all be valid, existing participants (and unique).
  if (captainSet.size !== captainIds.length) {
    err("V3", "Captain list contains duplicate ids.");
  }
  const participantIds = new Set(participants.map((p) => p.id));
  const unknownCaptains = captainIds.filter((id) => !participantIds.has(id));
  if (unknownCaptains.length > 0) {
    err("V3", `Captain id(s) not in participant list: ${unknownCaptains.join(", ")}.`);
  }

  // --- 6.2 Configuration ----------------------------------------------------
  if (P < 2) err("V4", `Persons per table must be >= 2 (got ${P}).`);
  if (R < minRounds || R > maxRounds) {
    err("V5", `Round count must be between ${minRounds} and ${maxRounds} (got ${R}).`);
  }
  const autoLogout = config.autoLogoutHours ?? DEFAULT_LIMITS.autoLogoutHours;
  if (autoLogout <= 0) err("V6", `Auto-logout hours must be > 0 (got ${autoLogout}).`);

  // --- 6.3 Capacity ---------------------------------------------------------
  // V7: enough people to form a table AND members left after captains.
  if (A < P) {
    err("V7", `Only ${A} active people; need at least ${P} to fill one table.`);
  }
  if (A <= T) {
    err(
      "V7",
      `No rotating members: ${A} people need ${T} captains, leaving ${A - T}. ` +
        `Increase people or persons-per-table.`,
    );
  }
  // V8: designated captains must equal table count.
  if (captainIds.length !== T && A >= P) {
    const diff = Math.abs(captainIds.length - T);
    if (captainIds.length < T) {
      err("V8", `Designate ${diff} more captain(s): need ${T}, have ${captainIds.length}.`);
    } else {
      err("V8", `Remove ${diff} captain(s) (or lower persons-per-table): need ${T}, have ${captainIds.length}.`);
    }
  }
  // V9: defensive capacity assertion.
  if (A > T * P) {
    err("V9", `Capacity overflow: ${A} people cannot fit in ${T} tables of ${P}.`);
  }

  // --- 6.4 Diversity feasibility (the easy-to-miss ones) --------------------
  const categoryCounts = new Map<string, number>();
  for (const p of participants) {
    const c = p.businessCategory?.trim();
    if (c) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }
  const distinctCategories = categoryCounts.size;
  // V10: a full table of P needs P distinct categories.
  if (distinctCategories < P) {
    err(
      "V10",
      `Only ${distinctCategories} distinct categories but tables seat ${P}. ` +
        `Lower persons-per-table or add categories.`,
    );
  }
  // V11: per round, each table holds at most one person of a category.
  const overRepresented = [...categoryCounts.entries()].filter(([, c]) => c > T);
  for (const [cat, c] of overRepresented) {
    err(
      "V11",
      `Category "${cat}" has ${c} people but only ${T} tables; ` +
        `they cannot all be seated in one round without a collision.`,
    );
  }
  // V12 (advisory): captains clustered in few categories tighten V11.
  const captainCategories = new Set(
    captainIds
      .map((id) => participants.find((p) => p.id === id)?.businessCategory)
      .filter(Boolean) as string[],
  );
  if (captainIds.length > 0 && captainCategories.size < captainIds.length) {
    warn(
      "V12",
      `Captains span only ${captainCategories.size} categories across ${captainIds.length} tables; ` +
        `repeated captain categories reduce seating flexibility.`,
    );
  }

  // --- 6.5 Advisory warnings ------------------------------------------------
  // W1: more rounds than needed to meet everyone => forced repeats.
  if (P > 1) {
    const roundsToMeetAll = Math.ceil((A - 1) / (P - 1));
    if (R > roundsToMeetAll) {
      warn(
        "W1",
        `${R} rounds exceeds the ~${roundsToMeetAll} needed to meet everyone; ` +
          `later rounds will force repeat pairings.`,
      );
    }
  }
  // W2: uneven tables.
  if (A % P !== 0) {
    warn("W2", `${A} people / ${P} per table is uneven; some tables seat ${P - 1}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    derived: {
      activeCount: A,
      tableCount: T,
      rotatingMembers: Math.max(0, A - T),
      distinctCategories,
      captainsRequired: T,
      captainsDesignated: captainIds.length,
    },
  };
}
