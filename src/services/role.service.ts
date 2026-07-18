import { collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import { ROLE_LOCKED_STATUSES } from "../domain/conclave.js";
import { getConclaveOrThrow, conclaveRef } from "./conclave.service.js";

export type Role = "captain" | "member";

/**
 * Assign a registered user to be a captain or a member for this conclave.
 *
 * This is the whole point of having an admin: the system cannot know who should
 * anchor a table — that is a human judgement about the room. Nothing else may
 * overwrite this decision.
 */
export async function setRole(conclaveId: string, uid: string, role: Role) {
  if (role !== "captain" && role !== "member") {
    throw ApiError.badRequest('role must be "captain" or "member".');
  }

  const { data } = await getConclaveOrThrow(conclaveId);
  const status = data.status ?? "";

  if (ROLE_LOCKED_STATUSES.has(status)) {
    throw ApiError.conflict(
      `Roles are frozen once the conclave is ${status}. They can only be changed before it starts.`,
    );
  }

  const regRef = conclaveRef(conclaveId)
    .collection(collections.registrations)
    .doc(uid);

  if (!(await regRef.get()).exists) {
    throw ApiError.notFound("That user is not registered for this conclave.");
  }

  await regRef.update({ role });
}
