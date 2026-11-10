import { describe, it, expect } from "vitest";
import { liveActivityFor, liveActivityKey, type LiveActivityRow } from "../liveActivityState.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 20, 4, 0, 0);

// 5 per table: 5 min bios + 2.5 min referrals = 7.5 min talk; 2 min move.
const row = (over: Partial<LiveActivityRow> = {}): LiveActivityRow => ({
  status: "running",
  currentRound: 1,
  currentRoundStartedAt: new Date(T0),
  roundCount: 3,
  personsPerTable: 5,
  roundProgressionMode: "automatic",
  moveSeconds: 120,
  roundExtensionSeconds: 0,
  isRoundPaused: false,
  schedule: {
    rounds: [
      { roundNumber: 1, tables: [{ tableNumber: 1, captainId: 1, memberIds: [2, 3] }, { tableNumber: 2, captainId: 4, memberIds: [5, 6] }] },
      { roundNumber: 2, tables: [{ tableNumber: 1, captainId: 1, memberIds: [5, 6] }, { tableNumber: 2, captainId: 4, memberIds: [2, 3] }] },
      { roundNumber: 3, tables: [{ tableNumber: 1, captainId: 1, memberIds: [3, 6] }, { tableNumber: 2, captainId: 4, memberIds: [2, 5] }] },
    ],
  },
  participants: [1, 2, 3, 4, 5, 6].map((id) => ({ id, _originalUid: `u${id}` })),
  ...over,
});

describe("liveActivityFor", () => {
  it("introductions count down to the end of the round's talking time", () => {
    const u = liveActivityFor(row(), "u2", T0 + 2 * MIN)!;
    expect(u.event).toBe("update");
    expect(u.content).toMatchObject({ round: 1, totalRounds: 3, tableNumber: 1, line: "Introductions · 1 min each", paused: false });
    expect(u.content.segmentEndEpoch).toBe((T0 + 7.5 * MIN) / 1000);
  });

  it("referral slot", () => {
    expect(liveActivityFor(row(), "u2", T0 + 6 * MIN)!.content.line).toBe("Referral round · pass your leads");
  });

  it("move break: members get their next table; captains stay", () => {
    const m = liveActivityFor(row(), "u2", T0 + 8 * MIN)!;
    expect(m.content.line).toBe("Move to Table 2");
    expect(m.content.segmentEndEpoch).toBe((T0 + 9.5 * MIN) / 1000);
    expect(liveActivityFor(row(), "u1", T0 + 8 * MIN)!.content.line).toBe("Stay at Table 1 · your next group is arriving");
  });

  it("paused freezes the card", () => {
    const r = row({ isRoundPaused: true, roundPausedAt: new Date(T0 + 3 * MIN), roundElapsedMsBeforePause: 3 * MIN } as never);
    expect(liveActivityFor(r, "u2", T0 + 20 * MIN)!.content.paused).toBe(true);
  });

  it("completed or cancelled conclaves end the card", () => {
    expect(liveActivityFor(row({ status: "completed" }), "u2")!.event).toBe("end");
    expect(liveActivityFor(row({ status: "cancelled" }), "u2")!.content.line).toBe("Conclave cancelled");
  });

  it("people not seated get nothing", () => {
    expect(liveActivityFor(row(), "stranger")).toBeNull();
  });
});

describe("liveActivityKey", () => {
  it("changes at every phase boundary, pause and extension — not every second", () => {
    const a = liveActivityKey(row(), T0 + 1 * MIN);
    expect(liveActivityKey(row(), T0 + 2 * MIN)).toBe(a);
    expect(liveActivityKey(row(), T0 + 6 * MIN)).not.toBe(a);
    expect(liveActivityKey(row({ roundExtensionSeconds: 120 }), T0 + 1 * MIN)).not.toBe(a);
    expect(liveActivityKey(row({ status: "completed" }))).toBe("status:completed");
  });
});
