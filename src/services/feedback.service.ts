import { and, desc, eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, feedback, registrations } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Post-conclave feedback, one row per member per conclave. Only members who
 * were registered for the conclave may submit; resubmitting overwrites and is
 * audited with the change.
 */

const VALID_TIMING = new Set(["short", "right", "long"]);

export async function submitFeedback(conclaveId: string, uid: string, body: any) {
  const rating = Number(body?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) throw ApiError.badRequest("rating must be a number from 1 to 5.");
  const referralsRaw = Number(body?.referrals);
  const values = {
    rating: Math.round(rating),
    timing: typeof body?.timing === "string" && VALID_TIMING.has(body.timing) ? body.timing : null,
    referrals: Number.isFinite(referralsRaw) && referralsRaw >= 0 ? Math.round(referralsRaw) : null,
    comment: typeof body?.comment === "string" ? body.comment.trim().slice(0, 1000) : "",
    submittedAt: new Date(),
  };

  await pgdb.transaction(async (tx) => {
    const [c] = await tx.select({ id: conclaves.id }).from(conclaves).where(eq(conclaves.id, conclaveId));
    if (!c) throw ApiError.notFound("Conclave not found.");
    const [reg] = await tx
      .select({ u: registrations.userId })
      .from(registrations)
      .where(and(eq(registrations.conclaveId, conclaveId), eq(registrations.userId, uid)));
    if (!reg) throw ApiError.forbidden("Only members registered for this conclave can leave feedback.");

    const where = and(eq(feedback.conclaveId, conclaveId), eq(feedback.userId, uid));
    const [before] = await tx.select().from(feedback).where(where).for("update");
    const [after] = await tx
      .insert(feedback)
      .values({ conclaveId, userId: uid, ...values })
      .onConflictDoUpdate({ target: [feedback.conclaveId, feedback.userId], set: values })
      .returning();
    await audit.change(
      { action: before ? "feedback.update" : "feedback.create", entityType: "feedback", entityId: `${conclaveId}:${uid}`, conclaveId, before: before ?? null, after },
      tx,
    );
  });
  return { ok: true };
}

export async function listFeedback(conclaveId: string) {
  const rows = await pgdb.select().from(feedback).where(eq(feedback.conclaveId, conclaveId)).orderBy(desc(feedback.submittedAt));
  const items = rows.map((x) => ({
    uid: x.userId,
    rating: x.rating,
    timing: x.timing,
    referrals: x.referrals,
    comment: x.comment,
    submittedAt: x.submittedAt.toISOString(),
  }));
  const avgRating = items.length ? +(items.reduce((s, i) => s + i.rating, 0) / items.length).toFixed(2) : null;
  return { count: items.length, avgRating, items };
}
