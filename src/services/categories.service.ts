import { sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { users, registrations } from "../db/schema.js";
import { ApiError } from "../middleware/errors.js";
import { readSetting, writeSetting } from "../repositories/settings.repo.js";
import { BUSINESS_CATEGORIES } from "../data/businessCategories.js";

/**
 * Business categories, managed from the admin panel and read live by the app.
 *
 * Stored in the `businessCategories` settings row (`categories: string[]`).
 * Every edit is audited with the before/after list.
 */

const KEY = "businessCategories";

const capitalizeFirst = (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1);

/** Clean + de-dupe (case-insensitively), sort A–Z, pin "Other" last. Strips control/null chars. */
function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const raw = String(e ?? "").trim();
    // Strip control characters (including null bytes \u0000) that crash Postgres jsonb
    const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
    if (!clean || clean.length > 100) continue;
    const s = capitalizeFirst(clean);
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
  const setting = await readSetting(KEY);
  const settingList = Array.isArray(setting?.categories) && setting.categories.length > 0
    ? setting.categories
    : BUSINESS_CATEGORIES;

  return normalize(settingList);
}

/** Replace the whole list (the primary admin edit). */
export async function setCategories(list: unknown): Promise<string[]> {
  const cleaned = normalize(list);
  if (cleaned.length === 0) {
    throw ApiError.badRequest("The category list cannot be empty.");
  }
  await writeSetting(KEY, { categories: cleaned });
  return cleaned;
}

export async function addCategory(name: unknown): Promise<string[]> {
  const raw = String(name ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  if (!raw) throw ApiError.badRequest("Category name is required.");
  const n = capitalizeFirst(raw);
  const current = await listCategories();
  if (current.some((c) => c.toLowerCase() === n.toLowerCase())) {
    throw ApiError.conflict(`"${n}" is already a category.`);
  }
  return setCategories([...current, n]);
}

export async function removeCategory(name: unknown): Promise<string[]> {
  const n = String(name ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().toLowerCase();
  if (!n) throw ApiError.badRequest("Category name is required.");
  const current = await listCategories();
  const next = current.filter((c) => c.toLowerCase() !== n);
  if (next.length === current.length) {
    throw ApiError.notFound(`"${name}" is not a category.`);
  }

  // Clear category reference on any members or registrations assigned to this removed category
  try {
    await pgdb.update(users).set({ category: null }).where(sql`LOWER(${users.category}) = ${n}`);
    await pgdb.update(registrations).set({ category: null }).where(sql`LOWER(${registrations.category}) = ${n}`);
  } catch (err) {
    console.error("Warning: failed to clear removed category from users/registrations:", err);
  }

  return setCategories(next);
}
