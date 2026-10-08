import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Post-conclave feedback, one doc per member at
 * `conclaves/{id}/feedback/{uid}`. Members submit from the summary screen;
 * admins read the lot. Replaces the ad-hoc Google Form.
 */

const feedbackRef = (conclaveId: string) =>
  db.collection(collections.conclaves).doc(conclaveId).collection("feedback");

const VALID_TIMING = new Set(["short", "right", "long"]);

export async function submitFeedback(conclaveId: string, uid: string, body: any) {
  const conclave = await db.collection(collections.conclaves).doc(conclaveId).get();
  if (!conclave.exists) throw ApiError.notFound("Conclave not found.");

  const rating = Number(body?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw ApiError.badRequest("rating must be a number from 1 to 5.");
  }
  const referralsRaw = Number(body?.referrals);

  const doc = {
    uid,
    rating: Math.round(rating),
    timing: typeof body?.timing === "string" && VALID_TIMING.has(body.timing) ? body.timing : null,
    referrals: Number.isFinite(referralsRaw) && referralsRaw >= 0 ? Math.round(referralsRaw) : null,
    comment: typeof body?.comment === "string" ? body.comment.trim().slice(0, 1000) : "",
    submittedAt: new Date(),
  };

  // One submission per member; resubmitting overwrites.
  await feedbackRef(conclaveId).doc(uid).set(doc, { merge: true });
  return { ok: true };
}

export async function listFeedback(conclaveId: string) {
  const snap = await feedbackRef(conclaveId).orderBy("submittedAt", "desc").get().catch(() => feedbackRef(conclaveId).get());
  const items = snap.docs.map((d) => {
    const x: any = d.data();
    return {
      uid: d.id,
      rating: x.rating ?? null,
      timing: x.timing ?? null,
      referrals: x.referrals ?? null,
      comment: x.comment ?? "",
      submittedAt: x.submittedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
  const rated = items.filter((i) => typeof i.rating === "number");
  const avgRating = rated.length
    ? +(rated.reduce((s, i) => s + (i.rating as number), 0) / rated.length).toFixed(2)
    : null;
  return { count: items.length, avgRating, items };
}
