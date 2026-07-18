import { describe, it, expect } from "vitest";
import { conclaveWindow, windowsOverlap } from "../schedulingRules.js";

const at = (iso: string) => new Date(iso);

/** A conclave with explicit start/end. */
const timed = (start: string, end: string) => ({
  date: at(start),
  startTime: at(start),
  endTime: at(end),
});

/** A conclave with only a date — no times set. */
const dateOnly = (day: string) => ({ date: at(`${day}T00:00:00`) });

describe("conclaveWindow", () => {
  it("uses start and end when both are given", () => {
    const w = conclaveWindow(timed("2026-01-01T09:00:00", "2026-01-01T11:00:00"))!;
    expect(w.start).toEqual(at("2026-01-01T09:00:00"));
    expect(w.end).toEqual(at("2026-01-01T11:00:00"));
  });

  it("falls back to the whole day when no times are set", () => {
    // We cannot prove two untimed conclaves don't overlap, so we assume they do.
    const w = conclaveWindow(dateOnly("2026-01-01"))!;
    expect(w.start.getHours()).toBe(0);
    expect(w.end.getHours()).toBe(23);
    expect(w.end.getMinutes()).toBe(59);
  });

  it("runs to the end of the day when only a start is known", () => {
    const w = conclaveWindow({
      date: at("2026-01-01T00:00:00"),
      startTime: at("2026-01-01T14:00:00"),
    })!;
    expect(w.start).toEqual(at("2026-01-01T14:00:00"));
    expect(w.end.getHours()).toBe(23);
  });

  it("returns null when there is no date at all", () => {
    expect(conclaveWindow({})).toBeNull();
  });
});

describe("registration clashes", () => {
  const clashes = (a: any, b: any) =>
    windowsOverlap(conclaveWindow(a)!, conclaveWindow(b)!);

  // The scenario as stated: 09:00-11:00 on 01-01-2026, two different venues.
  it("BLOCKS the same time on the same day at a different location", () => {
    const one = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const two = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    expect(clashes(one, two)).toBe(true);
  });

  it("ALLOWS the same time on a different day", () => {
    const one = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const two = timed("2026-01-02T09:00:00", "2026-01-02T11:00:00");
    expect(clashes(one, two)).toBe(false);
  });

  it("ALLOWS non-overlapping times on the same day", () => {
    const morning = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const evening = timed("2026-01-01T17:00:00", "2026-01-01T19:00:00");
    expect(clashes(morning, evening)).toBe(false);
  });

  it("ALLOWS back-to-back conclaves (one ends exactly as the other starts)", () => {
    // Half-open: 11:00 end and 11:00 start is not a clash. Treating it as one
    // would stop a legitimate morning + afternoon pairing.
    const a = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const b = timed("2026-01-01T11:00:00", "2026-01-01T13:00:00");
    expect(clashes(a, b)).toBe(false);
  });

  it("BLOCKS a partial overlap", () => {
    const a = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const b = timed("2026-01-01T10:30:00", "2026-01-01T12:30:00");
    expect(clashes(a, b)).toBe(true);
  });

  it("BLOCKS a conclave fully contained inside another", () => {
    const outer = timed("2026-01-01T09:00:00", "2026-01-01T18:00:00");
    const inner = timed("2026-01-01T11:00:00", "2026-01-01T12:00:00");
    expect(clashes(outer, inner)).toBe(true);
    expect(clashes(inner, outer)).toBe(true);
  });

  it("is symmetric", () => {
    const a = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    const b = timed("2026-01-01T10:00:00", "2026-01-01T12:00:00");
    expect(clashes(a, b)).toBe(clashes(b, a));
  });

  // The conservative fallback, stated as a test so the behaviour is deliberate.
  it("BLOCKS same-day registration when a conclave has no times set", () => {
    const untimed = dateOnly("2026-01-01");
    const timedOne = timed("2026-01-01T09:00:00", "2026-01-01T11:00:00");
    expect(clashes(untimed, timedOne)).toBe(true);
  });

  it("still ALLOWS a different day when times are missing", () => {
    expect(clashes(dateOnly("2026-01-01"), dateOnly("2026-01-02"))).toBe(false);
  });
});
