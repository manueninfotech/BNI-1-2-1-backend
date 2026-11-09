/**
 * Who sat where, indexed by uid.
 *
 * The server has to be able to answer two questions before it will accept a
 * record from a phone:
 *
 *   - "Is this person actually at that table in that round?"
 *   - "Is the caller the CAPTAIN of that table?"
 *
 * Without this, the sync endpoint takes the client's word for everything: a
 * member could mark anyone present or absent, claim to be a captain, or invent a
 * referral from someone they never met. The scanner enforces these rules on the
 * device, but the device is exactly what we cannot trust.
 *
 * Pure — no Firestore, no Express, so the rules are unit-testable.
 */

export interface ScheduleTable {
  tableNumber: number;
  /** Null in a captainless conclave. */
  captainId: number | null;
  memberIds: number[];
}

export interface ScheduleRound {
  roundNumber: number;
  tables: ScheduleTable[];
}

export interface StoredSchedule {
  rounds: ScheduleRound[];
}

export interface StoredParticipant {
  id: number;
  _originalUid: string;
}

/** Per-round stand-in captains: { "<round>": { "<tableNumber>": uid } }. */
export type StandInCaptains = Record<string, Record<string, string>>;

export interface SeatInfo {
  tableNumber: number;
  /**
   * uid of the captain for this table THIS round: the admin's stand-in if one
   * was marked, else the table's fixed anchor. Null when the table has none.
   */
  captainUid: string | null;
  /** uids of everyone at the table, captain included. */
  occupants: Set<string>;
}

export class ScheduleIndex {
  /** roundNumber -> uid -> seat */
  private readonly rounds = new Map<number, Map<string, SeatInfo>>();

  constructor(schedule: StoredSchedule, participants: StoredParticipant[], standIns: StandInCaptains = {}) {
    const uidOf = new Map<number, string>();
    for (const p of participants) {
      // Real user ids only — an engine's numeric seat id is never a uid.
      const uid = p?._originalUid || (p as any)?.uid || (p as any)?.userId || null;
      if (uid) uidOf.set(p.id, uid);
    }

    for (const round of schedule.rounds ?? []) {
      const seats = new Map<string, SeatInfo>();

      const roundStandIns = standIns[String(round.roundNumber)] ?? {};
      for (const table of round.tables ?? []) {
        const anchorUid = table.captainId === null || table.captainId === undefined ? null : uidOf.get(table.captainId) ?? null;

        const occupants = new Set<string>();
        if (anchorUid) occupants.add(anchorUid);
        for (const mid of table.memberIds ?? []) {
          const uid = uidOf.get(mid);
          if (uid) occupants.add(uid);
        }
        if (occupants.size === 0) continue;

        // A stand-in only counts if they actually sit at this table this round.
        const standIn = roundStandIns[String(table.tableNumber)];
        const captainUid = standIn && occupants.has(standIn) ? standIn : anchorUid;

        const info: SeatInfo = {
          tableNumber: table.tableNumber,
          captainUid,
          occupants,
        };
        for (const uid of occupants) seats.set(uid, info);
      }

      this.rounds.set(round.roundNumber, seats);
    }
  }

  /** Where [uid] sat in [roundNumber], or null if they weren't seated. */
  seatOf(roundNumber: number, uid: string): SeatInfo | null {
    return this.rounds.get(roundNumber)?.get(uid) ?? null;
  }

  /** Did these two share a table in this round? */
  sharedTable(roundNumber: number, a: string, b: string): boolean {
    const seat = this.seatOf(roundNumber, a);
    return seat !== null && seat.occupants.has(b);
  }

  /** Is [uid] the captain of [subject]'s table in this round? */
  isCaptainOf(roundNumber: number, uid: string, subject: string): boolean {
    const seat = this.seatOf(roundNumber, subject);
    return seat !== null && seat.captainUid !== null && seat.captainUid === uid;
  }

  /**
   * May [actor] record attendance for [subject] in this round?
   *
   * Exactly two people may: the person themselves, and the captain of the table
   * they are sitting at. Nobody else — not another member, not a captain from a
   * different table.
   */
  canMarkAttendance(roundNumber: number, actor: string, subject: string): boolean {
    if (actor === subject) return this.seatOf(roundNumber, subject) !== null;
    return this.isCaptainOf(roundNumber, actor, subject);
  }

  /**
   * May [from] refer [to] in this round?
   *
   * A referral is a promise made face to face at a table, so the two must
   * actually have shared one — and you cannot refer yourself.
   */
  canRefer(roundNumber: number, from: string, to: string): boolean {
    if (from === to) return false;
    return this.sharedTable(roundNumber, from, to);
  }
}
