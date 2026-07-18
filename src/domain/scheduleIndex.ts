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
  captainId: number;
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

export interface SeatInfo {
  tableNumber: number;
  /** uid of the captain anchoring this seat's table. */
  captainUid: string;
  /** uids of everyone at the table, captain included. */
  occupants: Set<string>;
}

export class ScheduleIndex {
  /** roundNumber -> uid -> seat */
  private readonly rounds = new Map<number, Map<string, SeatInfo>>();

  constructor(schedule: StoredSchedule, participants: StoredParticipant[]) {
    const uidOf = new Map<number, string>();
    for (const p of participants) {
      if (p?._originalUid) uidOf.set(p.id, p._originalUid);
    }

    for (const round of schedule.rounds ?? []) {
      const seats = new Map<string, SeatInfo>();

      for (const table of round.tables ?? []) {
        const captainUid = uidOf.get(table.captainId);
        if (!captainUid) continue; // schedule references someone not in the snapshot

        const occupants = new Set<string>([captainUid]);
        for (const mid of table.memberIds ?? []) {
          const uid = uidOf.get(mid);
          if (uid) occupants.add(uid);
        }

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
    return seat !== null && seat.captainUid === uid;
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
