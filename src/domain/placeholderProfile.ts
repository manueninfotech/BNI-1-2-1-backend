/**
 * Rejects test and placeholder details on a member's own profile ("Test User",
 * "John Doe", "ss", test.member01@mockdata.local), so the public cannot sign up
 * under names that look like test data. Organisers asked for this after test
 * accounts kept showing up in the member list.
 *
 * Deliberately narrow: whole words only, so real names such as "Testa" or
 * "Demon" pass. Pure, so it is unit-tested.
 */

const NAME_WORDS =
  /\b(test|tests|tester|testing|demo|dummy|sample|fake|mock|placeholder|asdf|asdfgh|qwerty|lorem|ipsum|xyz|abc|abcd|na|null|undefined)\b/i;
const NAME_PATTERNS = [
  /^(john|jane)\s+doe$/i,
  /^(user|member|guest|person|name|admin|customer)\s*\d*$/i,
];
const COMPANY_WORDS = /\b(test|tests|testing|dummy|fake|mock|placeholder|asdf|qwerty|lorem|ipsum)\b/i;
const EMAIL_DOMAINS =
  /@(example\.(com|org|net|in)|test\.com|mailinator\.com)$|\.(local|test|invalid|example)$/i;
const EMAIL_LOCAL = /^(test|tester|testuser|dummy|fake|demo|sample)[._\-+]?\w*@/i;

/**
 * Keyboard mash: "hhh4jjas", "asdkjh", "a12d1cw3". A word fails when it mixes
 * letters and digits, repeats a letter three times, or strings five consonants
 * together, not counting h (real names top out at four: "Kvsn", "Ananthchandra").
 */
export function gibberishWord(word: string): boolean {
  const w = word.toLowerCase().replace(/[.'\-]/g, "");
  if (!w) return false;
  if (/\p{L}/u.test(w) && /\d/.test(w)) return true;
  if (/(\p{L})\1\1/u.test(w)) return true;
  if (/[bcdfgjklmnpqrstvwxz]{5,}/.test(w)) return true;
  return /asdf|sdfg|dfgh|qwer|wert|zxcv|xcvb|hjkl|jkl|lkj|kjh|jhg|hgf|gfd|sdk|dkj/.test(w);
}

const words = (s: string) => s.split(/[\s,()/]+/).filter(Boolean);

export function placeholderName(raw: string): boolean {
  const name = raw.trim();
  if (/[^\p{L}\s.'\-]/u.test(name)) return true; // digits or symbols
  if (words(name).some(gibberishWord)) return true;
  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return true;
  if (/^(\p{L})\1*$/iu.test(letters) && letters.length <= 4) return true; // "ss", "aaa"
  if (NAME_WORDS.test(name)) return true;
  return NAME_PATTERNS.some((p) => p.test(name));
}

export function placeholderCompany(raw: string): boolean {
  return COMPANY_WORDS.test(raw.trim());
}

export function placeholderEmail(raw: string): boolean {
  const e = raw.trim().toLowerCase();
  return EMAIL_DOMAINS.test(e) || EMAIL_LOCAL.test(e);
}

/** A city or region a person typed: real words, no digits, no test words. */
export function placeholderPlace(raw: string): boolean {
  const place = raw.trim();
  if (!place) return false;
  const letters = place.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2 || /^(\p{L})\1*$/iu.test(letters)) return true;
  if (/[^\p{L}\s.,'\-()]/u.test(place)) return true;
  if (NAME_WORDS.test(place)) return true;
  return words(place).some(gibberishWord);
}
