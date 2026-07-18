import { describe, it, expect } from "vitest";
import { ScheduleIndex } from "../scheduleIndex.js";

// Round 1: table 1 = captain Ganesh(1) + Sravan(2), Bhanu(3)
//          table 2 = captain Kartheek(4) + Priya(5)
// Round 2: everyone shuffles.
const schedule = {
  rounds: [
    {
      roundNumber: 1,
      tables: [
        { tableNumber: 1, captainId: 1, memberIds: [2, 3] },
        { tableNumber: 2, captainId: 4, memberIds: [5] },
      ],
    },
    {
      roundNumber: 2,
      tables: [
        { tableNumber: 1, captainId: 1, memberIds: [5] },
        { tableNumber: 2, captainId: 4, memberIds: [2, 3] },
      ],
    },
  ],
};

const participants = [
  { id: 1, _originalUid: "ganesh" }, // captain of table 1
  { id: 2, _originalUid: "sravan" },
  { id: 3, _originalUid: "bhanu" },
  { id: 4, _originalUid: "kartheek" }, // captain of table 2
  { id: 5, _originalUid: "priya" },
];

const index = new ScheduleIndex(schedule, participants);

describe("ScheduleIndex", () => {
  it("finds where someone sat", () => {
    expect(index.seatOf(1, "sravan")!.tableNumber).toBe(1);
    expect(index.seatOf(1, "priya")!.tableNumber).toBe(2);
    expect(index.seatOf(1, "nobody")).toBeNull();
  });

  it("knows who the captain of a seat is", () => {
    expect(index.seatOf(1, "sravan")!.captainUid).toBe("ganesh");
    expect(index.seatOf(1, "priya")!.captainUid).toBe("kartheek");
  });

  it("tracks people moving between rounds", () => {
    expect(index.seatOf(1, "priya")!.tableNumber).toBe(2);
    expect(index.seatOf(2, "priya")!.tableNumber).toBe(1); // moved
    // Captains stay put.
    expect(index.seatOf(2, "ganesh")!.tableNumber).toBe(1);
  });
});

describe("canMarkAttendance — who may record whom", () => {
  it("lets a member mark THEMSELVES", () => {
    expect(index.canMarkAttendance(1, "sravan", "sravan")).toBe(true);
  });

  it("lets a captain mark someone AT THEIR TABLE", () => {
    expect(index.canMarkAttendance(1, "ganesh", "sravan")).toBe(true);
    expect(index.canMarkAttendance(1, "ganesh", "bhanu")).toBe(true);
  });

  // THE ATTACK. Without this, any member could mark anyone present or absent.
  it("STOPS a member marking another member", () => {
    expect(index.canMarkAttendance(1, "sravan", "bhanu")).toBe(false);
  });

  // Tables are inches apart at a real venue.
  it("STOPS a captain marking someone at ANOTHER table", () => {
    expect(index.canMarkAttendance(1, "ganesh", "priya")).toBe(false);
    expect(index.canMarkAttendance(1, "kartheek", "sravan")).toBe(false);
  });

  it("respects the rotation — a captain loses the right when the member moves away", () => {
    // Round 1: priya is at kartheek's table. Round 2: she moves to ganesh's.
    expect(index.canMarkAttendance(1, "kartheek", "priya")).toBe(true);
    expect(index.canMarkAttendance(2, "kartheek", "priya")).toBe(false);
    expect(index.canMarkAttendance(2, "ganesh", "priya")).toBe(true);
  });

  it("STOPS marking someone who isn't in the conclave at all", () => {
    expect(index.canMarkAttendance(1, "ganesh", "stranger")).toBe(false);
    expect(index.canMarkAttendance(1, "stranger", "stranger")).toBe(false);
  });

  it("STOPS marking for a round that does not exist", () => {
    expect(index.canMarkAttendance(99, "ganesh", "sravan")).toBe(false);
  });
});

describe("canRefer — a referral is a promise made face to face", () => {
  it("allows a referral between people who shared a table", () => {
    expect(index.canRefer(1, "sravan", "bhanu")).toBe(true);
    expect(index.canRefer(1, "sravan", "ganesh")).toBe(true); // to the captain
  });

  // THE ATTACK. Without this, a client could invent referrals with anyone.
  it("STOPS a referral to someone at another table", () => {
    expect(index.canRefer(1, "sravan", "priya")).toBe(false);
  });

  it("STOPS a self-referral", () => {
    expect(index.canRefer(1, "sravan", "sravan")).toBe(false);
  });

  it("STOPS a referral to someone not in the conclave", () => {
    expect(index.canRefer(1, "sravan", "stranger")).toBe(false);
  });

  it("follows the rotation — a pair separated this round cannot refer", () => {
    // sravan + priya never share in round 1, but do NOT share in round 2 either
    // (sravan -> table 2, priya -> table 1).
    expect(index.canRefer(2, "sravan", "priya")).toBe(false);
    // sravan and bhanu move together, so they still can.
    expect(index.canRefer(2, "sravan", "bhanu")).toBe(true);
  });

  it("is symmetric — either party may initiate", () => {
    expect(index.canRefer(1, "bhanu", "sravan")).toBe(index.canRefer(1, "sravan", "bhanu"));
  });
});
