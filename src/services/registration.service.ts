import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import { conclaveWindow, windowsOverlap } from "../domain/schedulingRules.js";
import { TERMINAL_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";
import { verifyPayment } from "./razorpay.service.js";

/** The registration fee for a conclave, in rupees. 0 (or unset) means free. */
export function registrationFeeOf(conclave: any): number {
  const fee = Number(conclave?.paymentDetails?.registrationFee);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/**
 * Everything that must be true before a member may register — reused by the
 * payment-order endpoint so we never open a Razorpay order for someone who
 * cannot actually register (registration closed, already in, or a time clash).
 * Charging them and then rejecting the registration is the one outcome to avoid.
 *
 * Returns `{ alreadyRegistered: true }` when they're already in (idempotent),
 * otherwise `{ conclave }`. Throws ApiError on a hard block.
 */
export async function assertRegisterable(conclaveId: string, uid: string) {
  const { data: conclave } = await getConclaveOrThrow(conclaveId);

  if (
    conclave.isRegistrationOpen === false ||
    conclave.status === "completed" ||
    conclave.status === "ended" ||
    conclave.status === "cancelled"
  ) {
    throw ApiError.conflict("Registration is not open for this conclave.");
  }

  const myReg = conclaveRef(conclaveId).collection(collections.registrations).doc(uid);
  if ((await myReg.get()).exists) {
    return { conclave, alreadyRegistered: true as const };
  }

  const target = conclaveWindow(conclave);
  if (!target) throw ApiError.conflict("This conclave has no date set yet.");

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

  return { conclave, alreadyRegistered: false as const };
}

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
  const check = await assertRegisterable(conclaveId, uid);
  if (check.alreadyRegistered) return { alreadyRegistered: true };
  const { conclave } = check;

  const myReg = conclaveRef(conclaveId)
    .collection(collections.registrations)
    .doc(uid);

  // --- Payment ---------------------------------------------------------------
  // If the conclave charges a registration fee, it must be settled here. Online
  // payments are verified against Razorpay (signature AND captured amount, see
  // razorpay.service). Offline payments are recorded as `pending` for an admin
  // to reconcile against the bank/UPI transfer. A free conclave skips all of it.
  const fee = registrationFeeOf(conclave);
  const payment = (details.payment ?? {}) as {
    method?: string; orderId?: string; paymentId?: string; signature?: string;
  };
  let paymentRecord: Record<string, any> = {};
  let regStatus = "pending";

  if (fee > 0) {
    if (payment.method === "online") {
      await verifyPayment({
        orderId: payment.orderId ?? "",
        paymentId: payment.paymentId ?? "",
        signature: payment.signature ?? "",
        expectedRupees: fee,
      });
      paymentRecord = {
        payment: {
          method: "online",
          status: "paid",
          amount: fee,
          currency: "INR",
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          signature: payment.signature,
          paidAt: new Date(),
        },
      };
      regStatus = "confirmed";
    } else if (payment.method === "offline") {
      // No money verified server-side — the member says they've paid by UPI/bank
      // and (optionally) supplied a UTR. Stays pending until an admin confirms.
      paymentRecord = {
        payment: {
          method: "offline",
          status: "pending",
          amount: fee,
          currency: "INR",
          utrNumber: details.utrNumber ?? null,
        },
      };
      regStatus = "pending";
    } else {
      throw ApiError.badRequest(
        "This conclave requires the registration fee to be paid before registering.",
        { paymentRequired: true, registrationFee: fee },
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
    status: regStatus,
    ...paymentRecord,
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
