import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import { conclaveWindow, windowsOverlap } from "../domain/schedulingRules.js";
import { TERMINAL_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";

/**
 * Register a member for a conclave.
 *
 * This lives on the server because the rule it enforces cannot be checked from a
 * single client: a member may not hold registrations for two conclaves whose
 * times OVERLAP. Nobody can attend both, and the schedule has already seated and
 * paired them — a no-show leaves a hole in other people's tables.
 *
 * Registration is deliberately FINAL. There is no withdraw endpoint.
 */
export async function register(conclaveId: string, uid: string) {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);

  if (conclave.isRegistrationOpen !== true) {
    throw ApiError.conflict("Registration is not open for this conclave.");
  }

  const myReg = conclaveRef(conclaveId)
    .collection(collections.registrations)
    .doc(uid);

  // Idempotent: a retry after a flaky network must not look like an error.
  if ((await myReg.get()).exists) {
    return { alreadyRegistered: true };
  }

  const target = conclaveWindow(conclave);
  if (!target) throw ApiError.conflict("This conclave has no date set yet.");

  // Only conclaves that could still happen can clash.
  const others = await db
    .collection(collections.conclaves)
    .where("status", "not-in", [...TERMINAL_STATUSES])
    .get();

  const candidates = others.docs.filter((d) => d.id !== conclaveId);

  if (candidates.length > 0) {
    const regs = await db.getAll(
      ...candidates.map((d) => d.ref.collection(collections.registrations).doc(uid)),
    );

    for (let i = 0; i < candidates.length; i++) {
      if (!regs[i].exists) continue;

      const other = candidates[i].data();
      const otherWindow = conclaveWindow(other);
      if (!otherWindow || !windowsOverlap(target, otherWindow)) continue;

      throw ApiError.conflict(
        `This clashes with "${other.name}", which you are already registered for. ` +
          `Two conclaves at the same time cannot both be attended, and registrations cannot be withdrawn.`,
        {
          conflictsWith: {
            conclaveId: candidates[i].id,
            name: other.name ?? "",
            venueLocation: other.venueLocation ?? "",
            start: otherWindow.start.toISOString(),
            end: otherWindow.end.toISOString(),
          },
        },
      );
    }
  }

  await myReg.set({
    userId: uid, // denormalised so registrations are queryable by user
    registeredAt: new Date(),
    role: "member",
    status: "pending",
  });

  return { alreadyRegistered: false };
}
