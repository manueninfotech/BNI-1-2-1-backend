/**
 * One-way copy: Firestore (read-only) → Postgres.
 *
 *   DATABASE_URL=postgres://localhost:5432/conclave_dev \
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.conclave-secrets/service-account.json \
 *   npx tsx scripts/importFromFirestore.ts [--allow-remote]
 *
 * - Never writes to Firestore.
 * - Re-runnable: wipes the Postgres tables first, inside one transaction, so a
 *   failed run leaves the previous copy intact.
 * - Refuses a non-local DATABASE_URL unless --allow-remote is passed, so it can't
 *   wipe a real database by accident.
 * - Fields with no column land in each row's `legacy` jsonb; the run ends with a
 *   report of every such field so nothing is dropped silently.
 */
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { pgdb, pool } from "../src/db/client.js";
import * as t from "../src/db/schema.js";
import { env } from "../src/config/env.js";
import { audit } from "../src/audit/audit.service.js";
import { runAsSystem } from "../src/observability/context.js";

if (!/localhost|127\.0\.0\.1/.test(env.databaseUrl) && !process.argv.includes("--allow-remote")) {
  console.error(`Refusing to import into a non-local database (${env.databaseUrl.replace(/:[^:@/]+@/, ":***@")}). Pass --allow-remote.`);
  process.exit(1);
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.replace(/^~/, process.env.HOME ?? "~");
initializeApp({ credential: keyPath ? cert(JSON.parse(readFileSync(keyPath, "utf8"))) : applicationDefault() });
const fs = getFirestore();

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const empty = (v: unknown) => v === undefined || v === null || v === "";

function toDate(v: unknown): Date | null {
  if (empty(v)) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
const toBool = (v: unknown, dflt = false) =>
  empty(v) ? dflt : typeof v === "string" ? ["true", "yes", "1"].includes(v.toLowerCase()) : Boolean(v);
const toInt = (v: unknown) => (empty(v) || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const toNum = (v: unknown) => (empty(v) || !Number.isFinite(Number(v)) ? null : Number(v));
const toStr = (v: unknown) => (empty(v) ? null : String(v));

/** Firestore Timestamps inside JSON blobs → ISO strings, so jsonb stays plain. */
function plain(v: unknown): any {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

// ---------------------------------------------------------------------------
// Field mapping: column ← first non-empty of several Firestore field names.
// Any other field (or a differing duplicate) is kept in `legacy`.
// ---------------------------------------------------------------------------

type Conv = (v: unknown) => unknown;
type Spec = Record<string, [string[], Conv]>;

const legacyReport = new Map<string, Map<string, number>>();

function mapDoc(table: string, data: DocumentData, spec: Spec, ignore: string[] = []) {
  const row: Record<string, unknown> = {};
  const used = new Set<string>(ignore);
  const legacy: Record<string, unknown> = {};

  for (const [col, [sources, conv]] of Object.entries(spec)) {
    let chosen: unknown = undefined;
    for (const s of sources) {
      const v = s.includes(".") ? s.split(".").reduce<any>((o, k) => o?.[k], data) : data[s];
      if (!s.includes(".")) used.add(s);
      if (empty(v)) continue;
      const c = conv(v);
      if (chosen === undefined && c !== null) chosen = c;
      else if (chosen !== undefined && JSON.stringify(plain(c)) !== JSON.stringify(plain(chosen))) {
        legacy[s] = plain(v); // a duplicate field that disagrees — keep it
      }
    }
    if (chosen !== undefined) row[col] = chosen;
  }
  for (const [k, v] of Object.entries(data)) {
    if (!used.has(k) && !empty(v)) legacy[k] = plain(v);
  }
  if (Object.keys(legacy).length) {
    const m = legacyReport.get(table) ?? new Map<string, number>();
    for (const k of Object.keys(legacy)) m.set(k, (m.get(k) ?? 0) + 1);
    legacyReport.set(table, m);
  }
  row.legacy = legacy;
  return row;
}

const S = toStr, D = toDate, I = toInt, N = toNum, B = (v: unknown) => toBool(v), J = plain;

// ---------------------------------------------------------------------------
// Collection specs
// ---------------------------------------------------------------------------

const userSpec: Spec = {
  name: [["name"], S], email: [["email"], S], identifier: [["identifier"], S], authEmail: [["authEmail"], S],
  phone: [["phone", "mobile"], S], company: [["company", "businessName"], S],
  category: [["category", "businessCategory"], S], chapter: [["chapter"], S],
  region: [["region"], S], state: [["state"], S], country: [["country"], S],
  location: [["location"], S], designation: [["designation"], S], membership: [["membership"], S],
  photoUrl: [["photoUrl"], S], canOffer: [["canOffer"], S], lookingFor: [["lookingFor"], S],
  role: [["role"], S], isCaptain: [["isCaptain", "isTableCaptain"], B], status: [["status"], S],
  isActive: [["isActive"], B], defaultPasswordAssigned: [["defaultPasswordAssigned"], B],
  lastLoginAt: [["lastLoginAt"], D], lastActiveAt: [["lastActiveAt"], D],
  createdAt: [["createdAt"], D], updatedAt: [["updatedAt"], D],
};

const adminSpec: Spec = {
  email: [["email"], S], name: [["name"], S], role: [["role"], S], region: [["region"], S],
  status: [["status"], S], phone: [["phone", "mobile"], S], organization: [["organization"], S],
  designation: [["designation"], S], chapter: [["chapter"], S],
  grantedAt: [["grantedAt", "createdAt"], D], updatedAt: [["updatedAt"], D],
};

const conclaveSpec: Spec = {
  name: [["name", "title"], S], description: [["description"], S],
  venueLocation: [["venueLocation", "venue", "location"], S], region: [["region"], S],
  coordinator: [["coordinator"], S], creator: [["creator"], S], theme: [["theme"], S],
  dateRange: [["dateRange"], S],
  startDate: [["startDate", "date"], D], endDate: [["endDate"], D],
  startTime: [["startTime"], S], endTime: [["endTime"], S],
  regStartDate: [["regStartDate"], D], regEndDate: [["regEndDate", "registrationCloseDate"], D],
  regStartTime: [["regStartTime"], S], regEndTime: [["regEndTime"], S],
  registrationOverride: [["registrationOverride"], S], isRegistrationOpen: [["isRegistrationOpen"], B],
  status: [["status"], S], memberLimit: [["memberLimit"], I], captainLimit: [["captainLimit"], I],
  registrationFee: [["registrationFee", "paymentDetails.registrationFee"], N],
  paymentDetails: [["paymentDetails"], J], chiefGuests: [["chiefGuests"], J],
  agendaDocument: [["agendaDocument"], J], allowAdminAddMembers: [["allowAdminAddMembers"], B],
  personsPerTable: [["personsPerTable"], I], roundCount: [["roundCount", "totalRounds"], I],
  seed: [["seed"], I], schedule: [["schedule"], J], participants: [["participants"], J],
  scheduleSummary: [["scheduleSummary"], J], warnings: [["warnings"], J], snapshot: [["snapshot"], J],
  isScheduleLocked: [["isScheduleLocked"], B],
  currentRound: [["currentRound"], I], currentRoundStartedAt: [["currentRoundStartedAt"], D],
  isRoundPaused: [["isRoundPaused"], B], roundPausedAt: [["roundPausedAt"], D],
  roundElapsedMsBeforePause: [["roundElapsedMsBeforePause"], I], startedBy: [["startedBy"], S],
  completedAt: [["completedAt"], D], cancelledAt: [["cancelledAt"], D],
  createdAt: [["createdAt"], D], updatedAt: [["updatedAt"], D],
};

const registrationSpec: Spec = {
  role: [["role"], S], status: [["status"], S], participantId: [["participantId"], I],
  tableNumber: [["tableNumber"], I], name: [["name"], S], email: [["email"], S],
  phone: [["phone", "mobile"], S], company: [["company", "businessName"], S],
  category: [["category", "businessCategory"], S], chapter: [["chapter"], S], region: [["region"], S],
  state: [["state"], S], country: [["country"], S], mealPreference: [["mealPreference"], S],
  needsAccommodation: [["needsAccommodation"], S], paymentStatus: [["paymentStatus"], S],
  amountPaid: [["amountPaid"], N], payment: [["payment"], J], addedBy: [["addedBy"], J],
  registeredAt: [["registeredAt"], D],
};

const attendanceSpec: Spec = {
  userId: [["userId"], S], roundNumber: [["roundNumber"], I], tableNumber: [["tableNumber"], I],
  captainMark: [["captainMark"], J], selfMark: [["selfMark"], J], isPresent: [["isPresent"], B],
  source: [["source"], S], markedBy: [["markedBy"], S], markedAt: [["markedAt"], D],
  syncedAt: [["syncedAt"], D],
};

const referralSpec: Spec = {
  fromUserId: [["fromUserId"], S], toUserId: [["toUserId"], S], fromName: [["fromName"], S],
  toName: [["toName"], S], roundNumber: [["roundNumber"], I], notes: [["notes"], S],
  status: [["status"], S], outcome: [["outcome"], S], outcomeNote: [["outcomeNote"], S],
  outcomeAt: [["outcomeAt"], D], closedAmount: [["closedAmount"], N],
  createdAt: [["createdAt"], D], syncedAt: [["syncedAt"], D],
};

const feedbackSpec: Spec = {
  rating: [["rating"], I], timing: [["timing"], S], referrals: [["referrals"], I],
  comment: [["comment"], S], submittedAt: [["submittedAt"], D],
};

const oneToOneSpec: Spec = {
  fromUserId: [["fromUserId"], S], toUserId: [["toUserId"], S], proposedAt: [["proposedAt"], D],
  location: [["location"], S], note: [["note"], S], status: [["status"], S],
  reminderSent: [["reminderSent"], B], createdAt: [["createdAt"], D], updatedAt: [["updatedAt"], D],
};

const notificationSpec: Spec = {
  title: [["title"], S], body: [["body"], S], type: [["type"], S], data: [["data"], J],
  read: [["read"], B], createdAt: [["createdAt"], D],
};

const paymentSpec: Spec = {
  orderId: [["orderId"], S], conclaveId: [["conclaveId"], S], uid: [["uid"], S], amount: [["amount"], N],
  currency: [["currency"], S], status: [["status"], S], method: [["method"], S], email: [["email"], S],
  contact: [["contact"], S], errorDescription: [["errorDescription"], S], lastEvent: [["lastEvent"], S],
  refundedAmount: [["refundedAmount"], N], refundId: [["refundId"], S], refundedAt: [["refundedAt"], D],
  createdAt: [["createdAt"], D], updatedAt: [["updatedAt"], D],
};

/** Tables without a `legacy` column: anything extra is reported, then dropped. */
const strip = (table: string, row: Record<string, unknown>) => {
  const { legacy, ...rest } = row;
  if (legacy && Object.keys(legacy as object).length) {
    console.warn(`  ! ${table}: fields with no column (not kept): ${Object.keys(legacy as object).join(", ")}`);
  }
  return rest;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const rows = {
    users: [] as any[], admins: [] as any[], regions: [] as any[], conclaves: [] as any[],
    registrations: [] as any[], attendance: [] as any[], referrals: [] as any[], feedback: [] as any[],
    oneToOnes: [] as any[], notifications: [] as any[], settings: [] as any[], payments: [] as any[],
  };

  for (const d of (await fs.collection("users").get()).docs) {
    rows.users.push({ uid: d.id, ...mapDoc("users", d.data(), userSpec, ["uid", "id"]) });
    for (const n of (await d.ref.collection("notifications").get()).docs) {
      rows.notifications.push(strip("notifications", { id: n.id, userId: d.id, ...mapDoc("notifications", n.data(), notificationSpec) }));
    }
  }
  // One admin per email. Firestore holds stale duplicates (an admin doc whose
  // uid has no Firebase Auth login); keep the doc that matches a real login.
  const byEmail = new Map<string, any[]>();
  for (const d of (await fs.collection("admins").get()).docs) {
    const row: any = { uid: d.id, ...mapDoc("admins", d.data(), adminSpec, ["uid"]) };
    const key = String(row.email ?? d.id).toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), row]);
  }
  for (const [email, list] of byEmail) {
    if (list.length === 1) { rows.admins.push(list[0]); continue; }
    const live = [];
    for (const r of list) { try { await getAuth().getUser(r.uid); live.push(r); } catch { /* no login */ } }
    const keep = live[0] ?? list[0];
    rows.admins.push(keep);
    console.warn(`  ! admins: ${list.length} docs for ${email}; kept uid ${keep.uid}, dropped ${list.filter((r) => r !== keep).map((r) => r.uid).join(", ")}`);
  }
  for (const d of (await fs.collection("regions").get()).docs) {
    // membersCount / conclavesCount are recomputed live, so they're dropped.
    const x = d.data();
    rows.regions.push({ id: d.id, name: x.name, status: x.status ?? "Active", createdAt: toDate(x.createdAt) ?? new Date() });
  }
  for (const d of (await fs.collection("conclaves").get()).docs) {
    rows.conclaves.push({ id: d.id, ...mapDoc("conclaves", d.data(), conclaveSpec, ["id"]) });
    for (const r of (await d.ref.collection("registrations").get()).docs) {
      const x = r.data();
      rows.registrations.push({
        conclaveId: d.id,
        userId: String(x.userId ?? x.uid ?? r.id),
        ...mapDoc("registrations", x, registrationSpec, ["userId", "uid", "isCaptain", "isTableCaptain"]),
        // `role` is the source of truth; the boolean flags only back-fill it.
        role: x.role ?? (x.isCaptain || x.isTableCaptain ? "captain" : "member"),
      });
    }
    for (const a of (await d.ref.collection("attendance").get()).docs) {
      rows.attendance.push(strip("attendance", { id: a.id, conclaveId: d.id, ...mapDoc("attendance", a.data(), attendanceSpec) }));
    }
    for (const r of (await d.ref.collection("referrals").get()).docs) {
      rows.referrals.push(strip("referrals", { id: r.id, conclaveId: d.id, ...mapDoc("referrals", r.data(), referralSpec) }));
    }
    for (const f of (await d.ref.collection("feedback").get()).docs) {
      rows.feedback.push(strip("feedback", { conclaveId: d.id, userId: f.id, ...mapDoc("feedback", f.data(), feedbackSpec, ["uid"]) }));
    }
  }
  for (const d of (await fs.collection("oneToOnes").get()).docs) {
    rows.oneToOnes.push(strip("one_to_ones", { id: d.id, ...mapDoc("one_to_ones", d.data(), oneToOneSpec) }));
  }
  for (const d of (await fs.collection("settings").get()).docs) {
    const { updatedAt, ...value } = d.data();
    rows.settings.push({ key: d.id, value: plain(value), updatedAt: toDate(updatedAt) ?? new Date() });
  }
  for (const d of (await fs.collection("payments").get()).docs) {
    rows.payments.push(strip("payments", { paymentId: d.id, ...mapDoc("payments", d.data(), paymentSpec, ["paymentId"]) }));
  }

  // Notifications for users that no longer exist can't satisfy the FK.
  const uids = new Set(rows.users.map((u) => u.uid));
  const orphanNotes = rows.notifications.filter((n) => !uids.has(n.userId)).length;
  rows.notifications = rows.notifications.filter((n) => uids.has(n.userId));
  // Child rows of a deleted conclave can't satisfy the FK either.
  const cids = new Set(rows.conclaves.map((c) => c.id));
  for (const k of ["registrations", "attendance", "referrals", "feedback"] as const) {
    rows[k] = rows[k].filter((r) => cids.has(r.conclaveId));
  }

  await pgdb.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE users, admins, regions, conclaves, registrations, attendance, referrals,
      feedback, one_to_ones, notifications, settings, payments CASCADE`);
    const ins = async (table: any, list: any[]) => {
      for (let i = 0; i < list.length; i += 200) await tx.insert(table).values(list.slice(i, i + 200));
    };
    await ins(t.users, rows.users);
    await ins(t.admins, rows.admins);
    await ins(t.regions, rows.regions);
    await ins(t.conclaves, rows.conclaves);
    await ins(t.registrations, rows.registrations);
    await ins(t.attendance, rows.attendance);
    await ins(t.referrals, rows.referrals);
    await ins(t.feedback, rows.feedback);
    await ins(t.oneToOnes, rows.oneToOnes);
    await ins(t.notifications, rows.notifications);
    await ins(t.settings, rows.settings);
    await ins(t.payments, rows.payments);
  });

  await audit.system("data.import_from_firestore", {
    counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
  });

  console.log("\nImported:");
  for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(14)} ${v.length}`);
  if (orphanNotes) console.log(`  (skipped ${orphanNotes} notifications of deleted users)`);
  console.log("\nKept in `legacy` (field: rows):");
  for (const [table, m] of legacyReport) {
    if (["notifications", "attendance", "referrals", "feedback", "one_to_ones", "payments"].includes(table)) continue;
    console.log(`  ${table}: ${[...m].map(([k, n]) => `${k}:${n}`).join(", ")}`);
  }
}

runAsSystem("import-from-firestore", main, "script")
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
