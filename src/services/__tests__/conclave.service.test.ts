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
      date: new Date(Date.now() - 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      registrationOverride: "open",
    });

    expect(result).toEqual({
      status: ConclaveStatus.running,
      isRegistrationOpen: false,
    });
  });
});
