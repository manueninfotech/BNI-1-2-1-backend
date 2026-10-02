import { db, collections } from "../config/firebase.js";

export const DEFAULT_AUTO_LOGOUT_HOURS = 5;

/**
 * The app-wide auto-logout window, from `settings/app`.
 *
 * Cached: it is read on most requests, it changes almost never, and each read is
 * a full Firestore round trip.
 */
let cache: { value: number; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function getAutoLogoutHours(): Promise<number> {
  if (cache && Date.now() < cache.expiresAt) return cache.value;

  let value = DEFAULT_AUTO_LOGOUT_HOURS;
  try {
    const doc = await db.collection(collections.settings).doc("app").get();
    const hours = doc.data()?.autoLogoutHours;
    if (typeof hours === "number" && hours > 0) value = hours;
  } catch {
    // Unreachable settings must not take the API down; the default is sane.
  }

  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

// ===========================================================================
// Admin-managed settings (one doc per concern under settings/*).
//
// settings/* is already readable by signed-in users (firestore.rules), so the
// app-facing ones need no rules change. Writes go only through these setters,
// behind admin routes. Each getter falls back to a sane default.
// ===========================================================================

const settingsRef = (doc: string) => db.collection(collections.settings).doc(doc);

async function readSettings(doc: string): Promise<Record<string, any>> {
  try {
    const snap = await settingsRef(doc).get();
    return snap.exists ? (snap.data() as Record<string, any>) : {};
  } catch {
    return {};
  }
}
async function writeSettings(doc: string, data: Record<string, any>): Promise<void> {
  await settingsRef(doc).set({ ...data, updatedAt: new Date() }, { merge: true });
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

export async function getRoundTiming(): Promise<RoundTiming> {
  const d = await readSettings("roundTiming");
  return {
    bioSeconds: posInt(d.bioSeconds, ROUND_TIMING_DEFAULTS.bioSeconds),
    referralSeconds: posInt(d.referralSeconds, ROUND_TIMING_DEFAULTS.referralSeconds),
    bufferSeconds: posInt(d.bufferSeconds, ROUND_TIMING_DEFAULTS.bufferSeconds),
  };
}
export async function setRoundTiming(input: Partial<RoundTiming>): Promise<RoundTiming> {
  const current = await getRoundTiming();
  const next: RoundTiming = {
    bioSeconds: posInt(input.bioSeconds, current.bioSeconds),
    referralSeconds: posInt(input.referralSeconds, current.referralSeconds),
    bufferSeconds: posInt(input.bufferSeconds, current.bufferSeconds),
  };
  await writeSettings("roundTiming", next);
  return next;
}

// ---- Default conclave config ----------------------------------------------
export interface ConclaveDefaults {
  personsPerTable: number;
  roundCount: number;
}
const CONCLAVE_DEFAULTS: ConclaveDefaults = { personsPerTable: 7, roundCount: 6 };

export async function getConclaveDefaults(): Promise<ConclaveDefaults> {
  const d = await readSettings("conclaveDefaults");
  return {
    personsPerTable: posInt(d.personsPerTable, CONCLAVE_DEFAULTS.personsPerTable),
    roundCount: posInt(d.roundCount, CONCLAVE_DEFAULTS.roundCount),
  };
}
export async function setConclaveDefaults(input: Partial<ConclaveDefaults>): Promise<ConclaveDefaults> {
  const current = await getConclaveDefaults();
  const next: ConclaveDefaults = {
    personsPerTable: posInt(input.personsPerTable, current.personsPerTable),
    roundCount: posInt(input.roundCount, current.roundCount),
  };
  await writeSettings("conclaveDefaults", next);
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
