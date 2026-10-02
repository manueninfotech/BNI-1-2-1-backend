import { db } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Business categories, managed from the admin panel and read live by the app.
 *
 * Stored at `settings/businessCategories` (field `categories: string[]`).
 * `settings/*` is already readable by any signed-in user (firestore.rules), so
 * the app reads it directly in real time — editing here reflects in the app with
 * no release. Writes go only through the Admin SDK (here).
 */

const SETTINGS = "settings";
const DOC = "businessCategories";

const ref = () => db.collection(SETTINGS).doc(DOC);

/** Clean + de-dupe (case-insensitively), sort A–Z, pin "Other" last. */
function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const s = String(e ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const oi = out.findIndex((c) => c.toLowerCase() === "other");
  if (oi >= 0) out.push(out.splice(oi, 1)[0]);
  return out;
}

export async function listCategories(): Promise<string[]> {
  const doc = await ref().get();
  return normalize(doc.exists ? (doc.data() as any)?.categories : null);
}

/** Replace the whole list (the primary admin edit). */
export async function setCategories(list: unknown): Promise<string[]> {
  const cleaned = normalize(list);
  if (cleaned.length === 0) {
    throw ApiError.badRequest("The category list cannot be empty.");
  }
  await ref().set({ categories: cleaned, updatedAt: new Date() }, { merge: true });
  return cleaned;
}

export async function addCategory(name: unknown): Promise<string[]> {
  const n = String(name ?? "").trim();
  if (!n) throw ApiError.badRequest("Category name is required.");
  const current = await listCategories();
  if (current.some((c) => c.toLowerCase() === n.toLowerCase())) {
    throw ApiError.conflict(`"${n}" is already a category.`);
  }
  return setCategories([...current, n]);
}

export async function removeCategory(name: unknown): Promise<string[]> {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) throw ApiError.badRequest("Category name is required.");
  const current = await listCategories();
  const next = current.filter((c) => c.toLowerCase() !== n);
  if (next.length === current.length) {
    throw ApiError.notFound(`"${name}" is not a category.`);
  }
  return setCategories(next);
}
