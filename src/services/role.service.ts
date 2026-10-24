import { and, eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, registrations } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { ROLE_LOCKED_STATUSES } from "../domain/conclave.js";

export type Role = "captain" | "member";

/**
 * Assign a registered user to be a captain or a member for this conclave.
 *
 * The system can't know who should anchor a table — that is a human judgement
 * about the room — so this admin decision is final and audited. Roles freeze
 * once the conclave starts.
 */
export async function setRole(conclaveId: string, uid: string, role: Role) {
  if (role !== "captain" && role !== "member") throw ApiError.badRequest('role must be "captain" or "member".');

  await pgdb.transaction(async (tx) => {
    const [c] = await tx.select({ status: conclaves.status }).from(conclaves).where(eq(conclaves.id, conclaveId)).for("share");
    if (!c) throw ApiError.notFound("Conclave not found.");
    if (ROLE_LOCKED_STATUSES.has(c.status)) {
      throw ApiError.conflict(`Roles are frozen once the conclave is ${c.status}. They can only be changed before it starts.`);
    }
    const where = and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid));
    const [before] = await tx.select().from(registrations).where(where).for("update");
    if (!before) throw ApiError.notFound("That user is not registered for this conclave.");
    if (before.role === role) return;
    const [after] = await tx.update(registrations).set({ role }).where(where).returning();
    await audit.change({ action: "registration.set_role", entityType: "registration", entityId: `${conclaveId}:${uid}`, conclaveId, before, after }, tx);
  });
}
