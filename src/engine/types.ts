// Core domain + engine types. Pure data, no React/DOM dependencies so the
// engine can be unit-tested in isolation and reused by the UI.

export interface Location {
  /** true => within Guntur; false => outside, and `place` should be set. */
  withinGuntur: boolean;
  /** Free-text place name when withinGuntur is false (e.g. "Vijayawada"). */
  place?: string;
}

export interface Participant {
  id: number;
  name: string;
  phone: string;
  businessName: string;
  /** The BNI business category — the diversity dimension for matching (C1). */
  businessCategory: string;
  location: Location;
  /** Optional BNI chapter (e.g. "Atoms", "Bytes"). */
  chapter?: string;
}

export interface ConclaveConfig {
  /** P — persons per table, including the captain. */
  personsPerTable: number;
  /** R — number of rounds. */
  roundCount: number;
  /** Seed for deterministic, reproducible schedules. */
  seed: number;
  minRounds?: number;
  maxRounds?: number;
  autoLogoutHours?: number;
}

export const DEFAULT_LIMITS = {
  minRounds: 4,
  maxRounds: 8,
  autoLogoutHours: 5,
} as const;

export interface TableSeating {
  tableNumber: number;
  captainId: number;
  /** Member ids seated this round, excluding the captain. */
  memberIds: number[];
}

/** Convenience: all occupant ids at a table = [captainId, ...memberIds]. */
export function occupantsOf(t: TableSeating): number[] {
  return [t.captainId, ...t.memberIds];
}

export interface RoundSeating {
  roundNumber: number;
  tables: TableSeating[];
}

export interface ScheduleStats {
  participants: number;
  tables: number;
  rounds: number;
  /** C(A,2) — every possible distinct pairing in the conclave. */
  totalPairsPossible: number;
  /** Distinct pairs that shared a table at least once. */
  uniquePairsMet: number;
  /** Times a pair shared a table beyond the first (soft-constraint cost, C2). */
  repeatPairings: number;
  avgUniqueMetPerMember: number;
  minUniqueMetPerMember: number;
  maxUniqueMetPerMember: number;
  /** uniquePairsMet / totalPairsPossible, 0..1. */
  coverage: number;
}

export interface Schedule {
  config: ConclaveConfig;
  tableCount: number;
  rounds: RoundSeating[];
  stats: ScheduleStats;
}

export type Severity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: Severity;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  derived: {
    /** A — active participant count. */
    activeCount: number;
    /** T — number of tables = ceil(A / P). */
    tableCount: number;
    /** Members that rotate = A - T. */
    rotatingMembers: number;
    distinctCategories: number;
    captainsRequired: number;
    captainsDesignated: number;
  };
}
