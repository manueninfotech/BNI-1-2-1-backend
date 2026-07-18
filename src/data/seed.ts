// Deterministic generator for ~300 Indian participants to exercise the engine.
// Same seed => same roster, so tests and the UI stay reproducible.

import { type Participant } from "../engine/types.js";
import { makeRng, shuffle, type Rng } from "../engine/rng.js";
import { BUSINESS_CATEGORIES } from "./businessCategories.js";
import { FIRST_NAMES, SURNAMES, BRAND_PREFIXES, OUTSIDE_PLACES, CHAPTERS } from "./names.js";

function pick<T>(arr: readonly T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length)];
}

function phone(rng: Rng): string {
  let n = "";
  n += 6 + Math.floor(rng() * 4); // leading 6-9
  for (let i = 0; i < 9; i++) n += Math.floor(rng() * 10);
  return "+91 " + n;
}

/**
 * Build `count` participants. Categories are distributed evenly (round-robin
 * over a shuffled category list) so per-category counts stay well under the
 * table count — keeping the C1 constraint comfortably feasible.
 */
export function generateSeedParticipants(count = 300, seed = 20260627): Participant[] {
  const rng = makeRng(seed);
  const cats = shuffle(BUSINESS_CATEGORIES, rng);
  const out: Participant[] = [];

  for (let i = 0; i < count; i++) {
    const category = cats[i % cats.length];
    const first = pick(FIRST_NAMES, rng);
    const surname = pick(SURNAMES, rng);
    const brand = pick(BRAND_PREFIXES, rng);

    const withinGuntur = rng() > 0.15; // ~85% local
    const place = withinGuntur ? undefined : pick(OUTSIDE_PLACES, rng);
    const chapter = rng() > 0.25 ? pick(CHAPTERS, rng) : undefined; // ~75% have a chapter

    out.push({
      id: i + 1,
      name: `${first} ${surname}`,
      phone: phone(rng),
      businessName: `${brand} ${shortCategory(category)}`,
      businessCategory: category,
      location: { withinGuntur, place },
      chapter,
    });
  }
  return out;
}

// Trim a category into a punchier business-name suffix.
function shortCategory(category: string): string {
  const map: Record<string, string> = {
    "Chartered Accountant": "Associates",
    "Software Development": "Technologies",
    "Web Design & Development": "Web Studio",
    "Digital Marketing": "Media",
    "Doctor - General Physician": "Clinic",
    "Diagnostic Lab": "Diagnostics",
    "Hospital & Healthcare": "Hospitals",
    "Advocate / Lawyer": "Legal",
    "Financial Planner": "Finserv",
    "Insurance Advisor": "Insurance",
    "Boutique & Fashion": "Boutique",
    "Packers & Movers": "Packers & Movers",
    "Education & Coaching": "Academy",
    "Study Abroad Consultant": "Overseas",
  };
  return map[category] ?? category;
}

/** A ready-to-use roster for the UI's "Load 300 sample businesses" button. */
export const SEED_PARTICIPANTS: Participant[] = generateSeedParticipants();
