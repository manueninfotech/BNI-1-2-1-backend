import { describe, expect, it } from "vitest";
import { roundPeopleFor } from "../roundPeople.js";

describe("roundPeopleFor", () => {
  it("per round: the larger of people-per-table and the biggest table (members + captain), at most 8", () => {
    const schedule = {
      rounds: [
        { roundNumber: 1, tables: [{ captainId: 1, memberIds: [2, 3, 4] }, { captainId: 5, memberIds: [6, 7, 8] }] },
        { roundNumber: 2, tables: [{ captainId: 1, memberIds: [2, 3, 4, 9, 10] }, { captainId: null, memberIds: [6, 7] }] },
        { roundNumber: 3, tables: [{ captainId: 1, memberIds: [2, 3, 4, 5, 6, 7, 8, 9, 10] }] },
      ],
    };
    expect(roundPeopleFor(schedule, 5)).toEqual([5, 6, 8]);
  });

  it("no schedule, no sizes", () => {
    expect(roundPeopleFor(null, 5)).toBeNull();
    expect(roundPeopleFor({ rounds: [] }, 5)).toBeNull();
  });
});
