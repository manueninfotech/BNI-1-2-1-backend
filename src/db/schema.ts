/**
 * Postgres schema — replaces the Firestore collections.
 *
 * Conventions
 * - Ids stay TEXT so every id the apps already hold (Firebase uids, Firestore
 *   auto-ids, client-generated attendance/referral ids) keeps working.
 * - Every timestamp is timestamptz. Firestore stored dates as a mix of
 *   Timestamps and ISO strings; the import script normalises both.
 * - Duplicate legacy fields are merged into one column (phone/mobile,
 *   company/businessName, category/businessCategory, isCaptain/isTableCaptain).
 * - `legacy` (jsonb) keeps any Firestore field that has no column, so the
 *   import never silently drops data. Nothing new should write to it.
 * - Event history (registrations, attendance, referrals, …) deliberately has no
 *   foreign key to users: a deleted account keeps its past event records.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  numeric,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const legacy = () => jsonb("legacy").$type<Record<string, unknown>>().notNull().default({});
const newId = () => text("id").primaryKey().default(sql`gen_random_uuid()::text`);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Members. `uid` is the Firebase Auth uid (login stays on Firebase). */
export const users = pgTable(
  "users",
  {
    uid: text("uid").primaryKey(),
    name: text("name").notNull().default(""),
    email: text("email"),
    /** Firebase sign-in address. For phone accounts it is synthetic
     *  (919515409973@bni121.conclave) — never show it to a human. */
    identifier: text("identifier"),
    authEmail: text("auth_email"),
    phone: text("phone"),
    company: text("company"),
    category: text("category"),
    chapter: text("chapter"),
    region: text("region"),
    state: text("state"),
    country: text("country"),
    location: text("location"),
    designation: text("designation"),
    membership: text("membership"),
    photoUrl: text("photo_url"),
    canOffer: text("can_offer"),
    lookingFor: text("looking_for"),
    role: text("role").notNull().default("member"),
    isCaptain: boolean("is_captain").notNull().default(false),
    status: text("status"),
    isActive: boolean("is_active").notNull().default(true),
    defaultPasswordAssigned: boolean("default_password_assigned").notNull().default(false),
    lastLoginAt: ts("last_login_at"),
    lastActiveAt: ts("last_active_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacy: legacy(),
  },
  (t) => [
    index("users_phone_idx").on(t.phone),
    index("users_email_idx").on(sql`lower(${t.email})`),
    index("users_identifier_idx").on(sql`lower(${t.identifier})`),
  ],
);

/**
 * Admin-panel accounts. Membership in this table IS the admin check — no
 * email-pattern shortcuts (see the deferred security fix in the migration notes).
 */
export const admins = pgTable("admins", {
  uid: text("uid").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("coordinator"), // superadmin | admin | coordinator
  region: text("region"),
  status: text("status").notNull().default("Active"),
  phone: text("phone"),
  organization: text("organization"),
  designation: text("designation"),
  chapter: text("chapter"),
  grantedAt: ts("granted_at").notNull().defaultNow(),
  updatedAt: updatedAt(),
  legacy: legacy(),
}, (t) => [uniqueIndex("admins_email_uq").on(sql`lower(${t.email})`)]);

export const regions = pgTable("regions", {
  id: newId(),
  name: text("name").notNull(),
  status: text("status").notNull().default("Active"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("regions_name_uq").on(sql`lower(${t.name})`)]);

// ---------------------------------------------------------------------------
// Conclaves
// ---------------------------------------------------------------------------

export const conclaves = pgTable(
  "conclaves",
  {
    id: newId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    venueLocation: text("venue_location").notNull().default(""),
    region: text("region"),
    coordinator: text("coordinator"),
    creator: text("creator"),
    theme: text("theme"),
    dateRange: text("date_range"),

    startDate: ts("start_date"),
    endDate: ts("end_date"),
    startTime: text("start_time"),
    endTime: text("end_time"),

    regStartDate: ts("reg_start_date"),
    regEndDate: ts("reg_end_date"),
    regStartTime: text("reg_start_time"),
    regEndTime: text("reg_end_time"),
    /** "auto" | "open" | "closed" — admin override of the registration window. */
    registrationOverride: text("registration_override").notNull().default("auto"),
    isRegistrationOpen: boolean("is_registration_open").notNull().default(false),

    status: text("status").notNull().default("registrationNotOpen"),
    memberLimit: integer("member_limit"),
    captainLimit: integer("captain_limit"),
    registrationFee: numeric("registration_fee", { mode: "number" }),
    paymentDetails: jsonb("payment_details").$type<Record<string, unknown>>(),
    chiefGuests: jsonb("chief_guests").$type<unknown[]>().notNull().default([]),
    agendaDocument: jsonb("agenda_document").$type<Record<string, unknown> | null>(),
    allowAdminAddMembers: boolean("allow_admin_add_members").notNull().default(false),

    // Scheduling (engine output is read and written whole, so it stays JSON).
    personsPerTable: integer("persons_per_table"),
    roundCount: integer("round_count"),
    seed: bigint("seed", { mode: "number" }),
    schedule: jsonb("schedule").$type<Record<string, unknown> | null>(),
    participants: jsonb("participants").$type<unknown[] | null>(),
    scheduleSummary: jsonb("schedule_summary").$type<Record<string, unknown> | null>(),
    warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
    snapshot: jsonb("snapshot").$type<Record<string, unknown> | null>(),
    isScheduleLocked: boolean("is_schedule_locked").notNull().default(false),

    // Live round state.
    roundProgressionMode: text("round_progression_mode").notNull().default("manual"), // "manual" | "automatic"
    roundDurationMinutes: integer("round_duration_minutes").notNull().default(15),
    roundExtensionSeconds: integer("round_extension_seconds").notNull().default(0),
    currentRound: integer("current_round").notNull().default(0),
    currentRoundStartedAt: ts("current_round_started_at"),
    isRoundPaused: boolean("is_round_paused").notNull().default(false),
    roundPausedAt: ts("round_paused_at"),
    roundElapsedMsBeforePause: bigint("round_elapsed_ms_before_pause", { mode: "number" }),
    startedBy: text("started_by"),

    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacy: legacy(),
  },
  (t) => [index("conclaves_status_idx").on(t.status), index("conclaves_start_idx").on(t.startDate)],
);

/** One row per member per conclave (was conclaves/{id}/registrations/{uid}). */
export const registrations = pgTable(
  "registrations",
  {
    conclaveId: text("conclave_id").notNull().references(() => conclaves.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // member | captain
    status: text("status"),
    participantId: integer("participant_id"),
    tableNumber: integer("table_number"),
    // Registration-time snapshot of the member's details.
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    category: text("category"),
    chapter: text("chapter"),
    region: text("region"),
    state: text("state"),
    country: text("country"),
    mealPreference: text("meal_preference"),
    needsAccommodation: text("needs_accommodation"),
    specialInstructions: text("special_instructions"),
    paymentStatus: text("payment_status"),
    amountPaid: numeric("amount_paid", { mode: "number" }),
    payment: jsonb("payment").$type<Record<string, unknown> | null>(),
    addedBy: jsonb("added_by").$type<Record<string, unknown> | null>(),
    registeredAt: ts("registered_at").notNull().defaultNow(),
    legacy: legacy(),
  },
  (t) => [
    primaryKey({ columns: [t.conclaveId, t.userId] }),
    index("registrations_user_idx").on(t.userId),
    // A Razorpay payment can pay for exactly one registration, ever.
    uniqueIndex("registrations_payment_id_uq").on(sql`(${t.payment}->>'paymentId')`).where(sql`${t.payment}->>'paymentId' IS NOT NULL`),
  ],
);

/** Offline-synced attendance marks; id is generated on the device. */
export const attendance = pgTable(
  "attendance",
  {
    id: text("id").primaryKey(),
    conclaveId: text("conclave_id").notNull().references(() => conclaves.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    roundNumber: integer("round_number").notNull(),
    tableNumber: integer("table_number"),
    captainMark: jsonb("captain_mark").$type<{ isPresent: boolean; at: string | null; by: string } | null>(),
    selfMark: jsonb("self_mark").$type<{ isPresent: boolean; at: string | null; by: string } | null>(),
    isPresent: boolean("is_present").notNull(),
    source: text("source").notNull(), // captain | self
    markedBy: text("marked_by"),
    markedAt: ts("marked_at"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [index("attendance_conclave_round_idx").on(t.conclaveId, t.roundNumber)],
);

/** Referrals passed during a conclave; id is generated on the device. */
export const referrals = pgTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    conclaveId: text("conclave_id").notNull().references(() => conclaves.id, { onDelete: "cascade" }),
    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),
    fromName: text("from_name"),
    toName: text("to_name"),
    roundNumber: integer("round_number").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("Pending"),
    outcome: text("outcome"),
    outcomeNote: text("outcome_note"),
    outcomeAt: ts("outcome_at"),
    closedAmount: numeric("closed_amount", { mode: "number" }),
    createdAt: ts("created_at"),
    syncedAt: ts("synced_at").notNull().defaultNow(),
  },
  (t) => [
    index("referrals_conclave_idx").on(t.conclaveId),
    index("referrals_to_idx").on(t.toUserId),
    index("referrals_from_idx").on(t.fromUserId),
  ],
);

/** Post-conclave feedback, one per member per conclave. */
export const feedback = pgTable(
  "feedback",
  {
    conclaveId: text("conclave_id").notNull().references(() => conclaves.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    rating: integer("rating").notNull(),
    timing: text("timing"),
    referrals: integer("referrals"),
    comment: text("comment").notNull().default(""),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conclaveId, t.userId] })],
);

// ---------------------------------------------------------------------------
// Member-to-member and notifications
// ---------------------------------------------------------------------------

export const oneToOnes = pgTable(
  "one_to_ones",
  {
    id: newId(),
    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),
    proposedAt: ts("proposed_at").notNull(),
    location: text("location").notNull().default(""),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | accepted | declined | cancelled
    reminderSent: boolean("reminder_sent").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("one_to_ones_from_idx").on(t.fromUserId),
    index("one_to_ones_to_idx").on(t.toUserId),
    index("one_to_ones_reminder_idx").on(t.status, t.reminderSent, t.proposedAt),
  ],
);

/** In-app notification inbox (was users/{uid}/notifications). */
export const notifications = pgTable(
  "notifications",
  {
    id: newId(),
    userId: text("user_id").notNull().references(() => users.uid, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    type: text("type"),
    data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
    read: boolean("read").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Settings and payments
// ---------------------------------------------------------------------------

/**
 * App-wide settings, one row per former settings document (categories, round
 * timing, notification templates, …). Small, rarely written, read whole.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
});

/** Razorpay payment ledger, one row per Razorpay payment id (webhook-written). */
export const payments = pgTable(
  "payments",
  {
    paymentId: text("payment_id").primaryKey(),
    orderId: text("order_id"),
    conclaveId: text("conclave_id"),
    uid: text("uid"),
    amount: numeric("amount", { mode: "number" }),
    currency: text("currency").notNull().default("INR"),
    status: text("status").notNull(),
    method: text("method"),
    email: text("email"),
    contact: text("contact"),
    errorDescription: text("error_description"),
    lastEvent: text("last_event"),
    refundedAmount: numeric("refunded_amount", { mode: "number" }),
    refundId: text("refund_id"),
    refundedAt: ts("refunded_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payments_conclave_idx").on(t.conclaveId)],
);

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Append-only record of every action taken in the system.
 *
 * Two kinds of row share this table, linked by `request_id`:
 * - kind = "request": written automatically for EVERY state-changing API call
 *   (and every rejected sign-in / permission check), whoever made it — mobile
 *   app, admin panel, webhook. Guarantees coverage even where no service
 *   remembered to log.
 * - kind = "change": written by the services for meaningful domain changes,
 *   with a field-level before → after diff in `changes`.
 * - kind = "system": scheduled jobs and scripts (no HTTP request).
 *
 * UPDATE and DELETE are blocked by a trigger (see the migration), so history
 * can't be rewritten from the application.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    kind: text("kind").notNull(), // request | change | system
    requestId: text("request_id"),

    // Who
    actorUid: text("actor_uid"),
    actorRole: text("actor_role"), // member | captain | coordinator | admin | superadmin | system | webhook | anonymous
    actorEmail: text("actor_email"),
    actorName: text("actor_name"),

    // From where
    source: text("source"), // mobile_app | admin_panel | webhook | system | script | unknown
    ip: text("ip"),
    userAgent: text("user_agent"),

    // What
    action: text("action").notNull(), // e.g. conclave.update, registration.create, http.POST
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    conclaveId: text("conclave_id"),
    changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }> | null>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    // Request + result
    method: text("method"),
    route: text("route"),
    statusCode: integer("status_code"),
    outcome: text("outcome").notNull().default("success"), // success | failure | denied
    error: text("error"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("audit_occurred_idx").on(t.occurredAt),
    index("audit_actor_idx").on(t.actorUid, t.occurredAt),
    index("audit_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    index("audit_conclave_idx").on(t.conclaveId, t.occurredAt),
    index("audit_action_idx").on(t.action, t.occurredAt),
    index("audit_request_idx").on(t.requestId),
  ],
);
