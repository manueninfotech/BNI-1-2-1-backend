import { sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { chapterKey } from "../engine/matcher.js";
import { ApiError } from "../middleware/errors.js";
import { readSetting, writeSetting } from "../repositories/settings.repo.js";

/**
 * BNI chapters, managed from the admin panel and offered to members as a pick
 * list at sign-up and in their profile. A typed chapter ("Amaravathi" vs
 * "Amaravati") splits one chapter in two, which weakens the "keep chapter
 * members apart" seating rule; a shared list keeps the spelling consistent.
 *
 * Stored in the `bniChapters` settings row (`chapters: string[]`). Unlike
 * categories the list may be empty: the app then falls back to a text field.
 * Two names count as the same chapter when the seating engine would treat them
 * as one (`chapterKey`: case, punctuation and the word "chapter" ignored).
 */

const KEY = "bniChapters";

const tidy = (value: unknown) => {
  const s = String(value ?? "").trim().replace(/\s+/g, " ");
  return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : "";
};

function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const s = tidy(e);
    const k = chapterKey(s);
    if (!s || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.slice(0, 80));
  }
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export async function listChapters(): Promise<string[]> {
  return normalize((await readSetting(KEY)).chapters);
}

/** Replace the whole list. An empty list switches the pick list off. */
export async function setChapters(list: unknown): Promise<string[]> {
  if (!Array.isArray(list)) throw ApiError.badRequest("Send the chapters as a list.");
  const cleaned = normalize(list);
  await writeSetting(KEY, { chapters: cleaned });
  return cleaned;
}

export async function addChapter(name: unknown): Promise<string[]> {
  const n = tidy(name);
  if (!chapterKey(n)) throw ApiError.badRequest("Chapter name is required.");
  const current = await listChapters();
  if (current.some((c) => chapterKey(c) === chapterKey(n))) {
    throw ApiError.conflict(`"${n}" is already on the list.`);
  }
  return setChapters([...current, n]);
}

export async function removeChapter(name: unknown): Promise<string[]> {
  const k = chapterKey(String(name ?? ""));
  if (!k) throw ApiError.badRequest("Chapter name is required.");
  const current = await listChapters();
  const next = current.filter((c) => chapterKey(c) !== k);
  if (next.length === current.length) throw ApiError.notFound(`"${name}" is not on the list.`);
  return setChapters(next);
}

/**
 * Chapters members have typed that are not on the list yet, most used first,
 * each shown in its most common spelling. Lets an organiser seed the list from
 * real data instead of typing it from memory.
 */
export async function chapterSuggestions(): Promise<Array<{ name: string; members: number }>> {
  const rows = (
    await pgdb.execute(sql`select chapter, count(*)::int as n from users where coalesce(trim(chapter), '') <> '' group by chapter`)
  ).rows as Array<{ chapter: string; n: number }>;
  const listed = new Set((await listChapters()).map(chapterKey));
  const groups = new Map<string, { best: string; bestN: number; members: number }>();
  for (const { chapter, n } of rows) {
    const k = chapterKey(chapter);
    if (!k || listed.has(k)) continue;
    const g = groups.get(k) ?? { best: tidy(chapter), bestN: 0, members: 0 };
    g.members += Number(n);
    if (Number(n) > g.bestN) {
      g.best = tidy(chapter);
      g.bestN = Number(n);
    }
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.members - a.members || a.best.localeCompare(b.best))
    .map((g) => ({ name: g.best, members: g.members }));
}

/** The listed spelling of a chapter a member typed, or what they typed. */
export async function canonicalChapter(raw: string): Promise<string> {
  const k = chapterKey(raw);
  if (!k) return raw;
  return (await listChapters()).find((c) => chapterKey(c) === k) ?? raw;
}
