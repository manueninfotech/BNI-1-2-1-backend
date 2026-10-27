import { describe, expect, it } from "vitest";
import { ConclaveStatus } from "../../domain/conclave.js";
import { evaluateConclaveStatus } from "../conclave.service.js";

describe("evaluateConclaveStatus registration overrides", () => {
  it("honors an explicit open override after the registration close date", () => {
    const result = evaluateConclaveStatus({
      date: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
      regEndDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.registrationOpen,
      isRegistrationOpen: true,
    });
  });

  it("honors an explicit open override before the registration start date", () => {
    const result = evaluateConclaveStatus({
      date: new Date(Date.now() + 48 * 60 * 60 * 1000),
      regStartDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.registrationOpen,
      isRegistrationOpen: true,
    });
  });

  it("does not allow an open override after the conclave starts", () => {
    const result = evaluateConclaveStatus({
      status: ConclaveStatus.running,
      date: new Date(Date.now() - 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.running,
      isRegistrationOpen: false,
    });
  });

  it("does not allow an open override when the schedule is locked", () => {
    const result = evaluateConclaveStatus({
      isScheduleLocked: true,
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.registrationClosed,
      isRegistrationOpen: false,
    });
  });

  it("keeps registration open up to the conclave being marked as locked", () => {
    // Registrations can happen up to the conclave status marked as locked
    const result = evaluateConclaveStatus({
      date: new Date(Date.now() - 30 * 60 * 1000), // started 30 mins ago
      endDate: new Date(Date.now() + 60 * 60 * 1000), // ends in 1 hr
      isScheduleLocked: false,
    });

    expect(result.status).toBe(ConclaveStatus.registrationOpen);
    expect(result.isRegistrationOpen).toBe(true);
  });

  it("does not auto-complete a running conclave merely because the event end time has passed", () => {
    // Admin started it (status is running). End date has passed.
    // Conclave must STAY running until admin explicitly finishes it!
    const result = evaluateConclaveStatus({
      status: ConclaveStatus.running,
      date: new Date(Date.now() - 3 * 60 * 60 * 1000),
      endDate: new Date(Date.now() - 1 * 60 * 60 * 1000), // ended 1 hr ago
    });

    expect(result).toEqual({
      status: ConclaveStatus.running,
      isRegistrationOpen: false,
    });
  });

  it("treats completed conclaves as terminal and never reopens registrations", () => {
    const result = evaluateConclaveStatus({
      status: "completed",
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.completed,
      isRegistrationOpen: false,
    });
  });
});
