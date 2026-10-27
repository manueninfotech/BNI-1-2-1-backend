import { readSetting, writeSetting } from "../repositories/settings.repo.js";

export const DEFAULT_AUTO_LOGOUT_HOURS = 5;

/**
 * The app-wide auto-logout window, from the `app` settings row.
 *
 * Cached: it is read on most requests, it changes almost never, and each read is
 * a database round trip.
 */
let cache: { value: number; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function getAutoLogoutHours(): Promise<number> {
  if (cache && Date.now() < cache.expiresAt) return cache.value;

  let value = DEFAULT_AUTO_LOGOUT_HOURS;
  const hours = (await readSetting("app")).autoLogoutHours;
  if (typeof hours === "number" && hours > 0) value = hours;

  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

// ===========================================================================
// Admin-managed settings (one doc per concern under settings/*).
//
// Stored in the Postgres `settings` table. Writes go only through these
// setters, behind admin routes, and are audited. Each getter falls back to a
// sane default.
// ===========================================================================

const readSettings = readSetting;
async function writeSettings(key: string, data: Record<string, any>): Promise<void> {
  await writeSetting(key, data);
}

function posInt(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

// ---- Round timing (talking cadence, seconds; mirrors the app) -------------
export interface RoundTiming {
  bioSeconds: number;
  referralSeconds: number;
  bufferSeconds: number;
}
const ROUND_TIMING_DEFAULTS: RoundTiming = { bioSeconds: 60, referralSeconds: 30, bufferSeconds: 120 };

let cachedRoundTiming: RoundTiming = { ...ROUND_TIMING_DEFAULTS };

export function getCachedRoundTiming(): RoundTiming {
  return cachedRoundTiming;
}

export async function getRoundTiming(): Promise<RoundTiming> {
  const d = await readSettings("roundTiming");
  cachedRoundTiming = {
    bioSeconds: posInt(d.bioSeconds, ROUND_TIMING_DEFAULTS.bioSeconds),
    referralSeconds: posInt(d.referralSeconds, ROUND_TIMING_DEFAULTS.referralSeconds),
    bufferSeconds: posInt(d.bufferSeconds, ROUND_TIMING_DEFAULTS.bufferSeconds),
  };
  return cachedRoundTiming;
}
export async function setRoundTiming(input: Partial<RoundTiming>): Promise<RoundTiming> {
  const current = await getRoundTiming();
  const next: RoundTiming = {
    bioSeconds: posInt(input.bioSeconds, current.bioSeconds),
    referralSeconds: posInt(input.referralSeconds, current.referralSeconds),
    bufferSeconds: posInt(input.bufferSeconds, current.bufferSeconds),
  };
  await writeSettings("roundTiming", next);
  cachedRoundTiming = next;
  return next;
}

// ---- Default conclave config ----------------------------------------------
export interface ConclaveDefaults {
  personsPerTable: number;
  roundCount: number;
  roundDurationMinutes: number;
}
const CONCLAVE_DEFAULTS: ConclaveDefaults = { personsPerTable: 7, roundCount: 6, roundDurationMinutes: 15 };

let cachedConclaveDefaults: ConclaveDefaults = { ...CONCLAVE_DEFAULTS };

export function getCachedConclaveDefaults(): ConclaveDefaults {
  return cachedConclaveDefaults;
}

export async function getConclaveDefaults(): Promise<ConclaveDefaults> {
  const d = await readSettings("conclaveDefaults");
  cachedConclaveDefaults = {
    personsPerTable: posInt(d.personsPerTable, CONCLAVE_DEFAULTS.personsPerTable),
    roundCount: posInt(d.roundCount, CONCLAVE_DEFAULTS.roundCount),
    roundDurationMinutes: posInt(d.roundDurationMinutes, CONCLAVE_DEFAULTS.roundDurationMinutes),
  };
  return cachedConclaveDefaults;
}
export async function setConclaveDefaults(input: Partial<ConclaveDefaults>): Promise<ConclaveDefaults> {
  const current = await getConclaveDefaults();
  const next: ConclaveDefaults = {
    personsPerTable: posInt(input.personsPerTable, current.personsPerTable),
    roundCount: posInt(input.roundCount, current.roundCount),
    roundDurationMinutes: posInt(input.roundDurationMinutes, current.roundDurationMinutes),
  };
  await writeSettings("conclaveDefaults", next);
  cachedConclaveDefaults = next;
  return next;
}

// ---- Regions --------------------------------------------------------------
const REGION_DEFAULTS = ["Global BNI Network", "Guntur Region"];

function cleanList(list: unknown, fallback: string[]): string[] {
  if (!Array.isArray(list)) return fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const s = String(e ?? "").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.length ? out : fallback;
}
export async function getRegions(): Promise<string[]> {
  return cleanList((await readSettings("regions")).regions, REGION_DEFAULTS);
}
export async function setRegions(list: unknown): Promise<string[]> {
  const next = cleanList(list, REGION_DEFAULTS);
  await writeSettings("regions", { regions: next });
  return next;
}

// ---- Notification templates ({token} placeholders filled at send time) ----
export interface NotifTemplate { title: string; body: string }
export interface NotificationTemplates {
  roundStarted: NotifTemplate;
  conclaveEnded: NotifTemplate;
  referralReceived: NotifTemplate;
}
const NOTIF_DEFAULTS: NotificationTemplates = {
  roundStarted: {
    title: "Round {round} has started",
    body: "Go to your table — open the app to see who you're sitting with.",
  },
  conclaveEnded: {
    title: "The conclave has ended",
    body: "Open the app to see your summary, your referrals, and whether your data has synced.",
  },
  referralReceived: { title: "New referral 🎉", body: "{giver} just passed you a referral." },
};

function pickTemplate(raw: any, fallback: NotifTemplate): NotifTemplate {
  const title = typeof raw?.title === "string" && raw.title.trim() ? raw.title : fallback.title;
  const body = typeof raw?.body === "string" && raw.body.trim() ? raw.body : fallback.body;
  return { title, body };
}
export async function getNotificationTemplates(): Promise<NotificationTemplates> {
  const d = await readSettings("notificationTemplates");
  return {
    roundStarted: pickTemplate(d.roundStarted, NOTIF_DEFAULTS.roundStarted),
    conclaveEnded: pickTemplate(d.conclaveEnded, NOTIF_DEFAULTS.conclaveEnded),
    referralReceived: pickTemplate(d.referralReceived, NOTIF_DEFAULTS.referralReceived),
  };
}
export async function setNotificationTemplates(
  input: Partial<NotificationTemplates>,
): Promise<NotificationTemplates> {
  const current = await getNotificationTemplates();
  const next: NotificationTemplates = {
    roundStarted: pickTemplate(input.roundStarted, current.roundStarted),
    conclaveEnded: pickTemplate(input.conclaveEnded, current.conclaveEnded),
    referralReceived: pickTemplate(input.referralReceived, current.referralReceived),
  };
  await writeSettings("notificationTemplates", next);
  return next;
}

/** Fill {token} placeholders; unknown tokens are left as-is. */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
/** Load a template and fill it — the one call sites use. */
export async function resolveNotification(
  key: keyof NotificationTemplates,
  vars: Record<string, string | number> = {},
): Promise<NotifTemplate> {
  const t = (await getNotificationTemplates())[key];
  return { title: fillTemplate(t.title, vars), body: fillTemplate(t.body, vars) };
}
