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
export async function register(conclaveId: string, uid: string, details: Record<string, any> = {}) {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);

  if (
    conclave.isRegistrationOpen === false ||
    conclave.status === "completed" ||
    conclave.status === "ended" ||
    conclave.status === "cancelled"
  ) {
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

  const {
    name, email, phone, company, category, chapter,
    region, state, country, mealPreference, needsAccommodation,
    specialInstructions, utrNumber
  } = details;

  await myReg.set({
    userId: uid, // denormalised so registrations are queryable by user
    registeredAt: new Date(),
    role: "member",
    status: "pending",
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(company ? { company } : {}),
    ...(category ? { category } : {}),
    ...(chapter ? { chapter } : {}),
    ...(region ? { region } : {}),
    ...(state ? { state } : {}),
    ...(country ? { country } : {}),
    ...(mealPreference ? { mealPreference } : {}),
    ...(needsAccommodation ? { needsAccommodation } : {}),
    ...(specialInstructions ? { specialInstructions } : {}),
    ...(utrNumber ? { utrNumber } : {}),
  }, { merge: true });

  // Sync region, state, country, chapter to user doc
  const userRef = db.collection(collections.users).doc(uid);
  const userUpdate: Record<string, any> = {};
  if (region) userUpdate.region = region;
  if (state) userUpdate.state = state;
  if (country) userUpdate.country = country;
  if (chapter) userUpdate.chapter = chapter;
  if (company) userUpdate.company = company;
  if (category) userUpdate.category = category;
  if (name) userUpdate.name = name;
  if (phone) userUpdate.phone = phone;

  if (Object.keys(userUpdate).length > 0) {
    await userRef.set(userUpdate, { merge: true }).catch(() => {});
  }

  return { alreadyRegistered: false };
}
