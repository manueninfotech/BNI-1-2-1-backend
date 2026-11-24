import { describe, expect, it } from "vitest";
import { liveClock, materialize, phases, referralSlot, roundEndMs, roundStartMs, type ClockRow } from "../roundClock.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 5, 0, 0);
const row = (over: Partial<ClockRow> = {}): ClockRow => ({
  currentRound: 1,
  currentRoundStartedAt: new Date(T0),
  roundCount: 4,
  personsPerTable: 8,
  roundProgressionMode: "manual",
  roundExtensionSeconds: 0,
  moveSeconds: 120,
  isRoundPaused: false,
  roundElapsedMsBeforePause: null,
  ...over,
});

describe("round shape", () => {
  it("8 per table: bios 8 min, referrals 4 min = 12 min; tables never exceed 8", () => {
    expect(phases(row())).toEqual({ bioMs: 8 * MIN, referralMs: 4 * MIN, talkMs: 12 * MIN });
    expect(phases(row({ personsPerTable: 6 })).talkMs).toBe(9 * MIN);
    expect(phases(row({ personsPerTable: 10 })).talkMs).toBe(12 * MIN);
  });

  it("referrals only in the slot after all bios", () => {
    expect(referralSlot(row(), 1)).toEqual({ opens: T0 + 8 * MIN, closes: T0 + 12 * MIN });
  });

  it("an extension adds time after the referral slot, not to it", () => {
    const r = row({ roundExtensionSeconds: 120 });
    expect(referralSlot(r, 1)).toEqual({ opens: T0 + 8 * MIN, closes: T0 + 12 * MIN });
    expect(roundEndMs(r, 1)).toBe(T0 + 14 * MIN);
    expect(liveClock(r, T0 + 13 * MIN).phase).toBe("extension");
  });
});

describe("manual mode (default)", () => {
  it("shows a move break, then waits for the admin; the last round reads as done", () => {
    expect(liveClock(row(), T0 + 1 * MIN)).toMatchObject({ round: 1, phase: "bio" });
    expect(liveClock(row(), T0 + 9 * MIN)).toMatchObject({ round: 1, phase: "referral" });
    expect(liveClock(row(), T0 + 12 * MIN)).toMatchObject({ round: 1, phase: "move", phaseEndsMs: T0 + 14 * MIN });
    expect(liveClock(row(), T0 + 13 * MIN)).toMatchObject({ round: 1, phase: "move", phaseEndsMs: T0 + 14 * MIN });
    expect(liveClock(row(), T0 + 14 * MIN)).toMatchObject({ round: 1, phase: "waiting", phaseEndsMs: null });
    expect(liveClock(row(), T0 + 30 * MIN)).toMatchObject({ round: 1, phase: "waiting", phaseEndsMs: null });
    expect(roundStartMs(row(), 2)).toBeNull();
    expect(liveClock(row({ currentRound: 4 }), T0 + 30 * MIN).phase).toBe("done");
  });

  it("does not advance the next round when the move break ends", () => {
    expect(roundStartMs(row(), 2)).toBeNull();
    expect(liveClock(row(), T0 + 14 * MIN)).toMatchObject({ round: 1, phase: "waiting" });
  });
});

describe("automatic mode", () => {
  const auto = (over: Partial<ClockRow> = {}) => row({ roundProgressionMode: "automatic", ...over });

  it("moves on after talk + move time", () => {
    expect(liveClock(auto(), T0 + 13 * MIN)).toMatchObject({ round: 1, phase: "move" });
    expect(roundStartMs(auto(), 2)).toBe(T0 + 14 * MIN);
    expect(liveClock(auto(), T0 + 15 * MIN)).toMatchObject({ round: 2, phase: "bio" });
    expect(referralSlot(auto(), 2)).toEqual({ opens: T0 + 22 * MIN, closes: T0 + 26 * MIN });
  });

  it("an extension on the current round pushes the later rounds back", () => {
    expect(roundStartMs(auto({ roundExtensionSeconds: 300 }), 2)).toBe(T0 + 19 * MIN);
    expect(roundStartMs(auto({ roundExtensionSeconds: 300, moveSeconds: 60 }), 3)).toBe(T0 + 18 * MIN + 13 * MIN);
  });

  it("stops after the last round", () => {
    expect(liveClock(auto(), T0 + 200 * MIN)).toMatchObject({ round: 4, phase: "done" });
  });

  it("materialize names the round the clock is on (for mode switches / extensions)", () => {
    expect(materialize(auto(), T0 + 15 * MIN)).toEqual({ currentRound: 2, currentRoundStartedAt: new Date(T0 + 14 * MIN), roundExtensionSeconds: 0 });
    expect(materialize(auto(), T0 + 5 * MIN)).toEqual({});
  });
});

describe("pause", () => {
  it("freezes the clock", () => {
    const paused = row({ isRoundPaused: true, roundElapsedMsBeforePause: 3 * MIN });
    expect(liveClock(paused, T0 + 60 * MIN)).toMatchObject({ round: 1, phase: "bio" });
  });
});

// Same cases in the panel (src/utils/roundClock.test.js) and the app
// (test/round_clock_test.dart): keep all three in step.
describe("per-round sizes (walk-ins enlarge later rounds)", () => {
  // Tables of 5; a walk-in re-plan makes round 3's biggest table 6.
  const sized = (over: Partial<ClockRow> = {}) =>
    row({ personsPerTable: 5, roundPeople: [5, 5, 6, 5], roundProgressionMode: "automatic", ...over });

  it("each round is timed for its own size", () => {
    expect(phases(sized(), 1).talkMs).toBe(7.5 * MIN);
    expect(phases(sized(), 3).talkMs).toBe(9 * MIN);
    expect(referralSlot(sized(), 1)).toEqual({ opens: T0 + 5 * MIN, closes: T0 + 7.5 * MIN });
  });

  it("automatic: later rounds start after each earlier round's own length", () => {
    // R1 7.5 + move 2 = 9.5; R2 7.5 + 2 = 19; R3 9 + 2 = 30.
    expect(roundStartMs(sized(), 2)).toBe(T0 + 9.5 * MIN);
    expect(roundStartMs(sized(), 3)).toBe(T0 + 19 * MIN);
    expect(roundStartMs(sized(), 4)).toBe(T0 + 30 * MIN);
    // In round 3 the bio phase runs 6 minutes, not 5.
    expect(liveClock(sized(), T0 + 19 * MIN + 5.5 * MIN)).toMatchObject({ round: 3, phase: "bio" });
    expect(liveClock(sized(), T0 + 19 * MIN + 6.5 * MIN)).toMatchObject({ round: 3, phase: "referral" });
  });

  it("without stored sizes, or out of range, it falls back to people-per-table", () => {
    expect(phases(row({ personsPerTable: 5 }), 3).talkMs).toBe(7.5 * MIN);
    expect(phases(sized(), 9).talkMs).toBe(7.5 * MIN);
    expect(phases(sized({ roundPeople: [12] }), 1).talkMs).toBe(12 * MIN);
  });
});
