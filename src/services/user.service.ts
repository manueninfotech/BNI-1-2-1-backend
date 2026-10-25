import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { auth } from "../config/firebase.js";
import { pgdb } from "../db/client.js";
import { admins, conclaves, registrations, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { getAutoLogoutHours } from "./settings.service.js";

/**
 * Members (the `users` table). Login stays on Firebase Auth; `uid` is the
 * Firebase uid. Every profile change is audited.
 *
 * Response shapes keep the field names the app and admin panel already use
 * (`businessName`, `businessCategory`, `mobile`, …) so the switch to Postgres
 * needs no client change.
 */

export type UserRow = typeof users.$inferSelect;

/** Synthetic sign-in addresses for phone accounts — never shown to a human. */
export const PHONE_ACCOUNT_DOMAIN = "@bni121.conclave";
const isSynthetic = (v?: string | null) => !!v && v.toLowerCase().endsWith(PHONE_ACCOUNT_DOMAIN);

/** "+919515409973" from "9515409973" / "919515409973" / "+91 95154 09973". */
export function normalizePhone(raw: unknown): { phone: string; tenDigit: string; identifier: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11 || digits.length > 15) throw ApiError.badRequest("Enter a valid phone number.");
  return { phone: `+${digits}`, tenDigit: digits.slice(-10), identifier: `${digits}${PHONE_ACCOUNT_DOMAIN}` };
}

export async function fetchUsers(uids: string[]): Promise<Map<string, UserRow>> {
  const out = new Map<string, UserRow>();
  const unique = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await pgdb.select().from(users).where(inArray(users.uid, unique.slice(i, i + 500)));
    for (const r of rows) out.set(r.uid, r);
  }
  return out;
}

export async function getUser(uid: string): Promise<UserRow | null> {
  const [row] = await pgdb.select().from(users).where(eq(users.uid, uid));
  return row ?? null;
}

/** A member's display name, for notification copy. */
export async function displayName(uid: string): Promise<string> {
  try {
    return (await getUser(uid))?.name || "A member";
  } catch {
    return "A member";
  }
}

/**
 * "Active" = logged in and not yet auto-logged-out. Derived from lastLoginAt
 * rather than phones reporting in, because at the venue the phones may not be
 * able to reach anything.
 */
export function isActiveUser(user: Pick<UserRow, "lastLoginAt"> | undefined | null, autoLogoutHours: number, now: Date): boolean {
  if (!user?.lastLoginAt) return false;
  return now.getTime() - user.lastLoginAt.getTime() < autoLogoutHours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Member directory (visible to every signed-in member → safe fields ONLY)
// ---------------------------------------------------------------------------

export async function listMemberDirectory() {
  const rows = await pgdb
    .select()
    .from(users)
    .where(sql`trim(${users.name}) <> ''`)
    .orderBy(asc(users.name));
  // Contact details (email, phone, identifier) are deliberately never included.
  return rows.map((d) => ({
    uid: d.uid,
    name: d.name.trim(),
    photoUrl: d.photoUrl ?? null,
    businessName: (d.company ?? "").trim(),
    businessCategory: (d.category ?? "").trim(),
    location: (d.location ?? "").trim(),
    chapter: d.chapter ?? null,
    region: d.region ?? null,
    membership: (d.membership ?? "").trim(),
    lookingFor: (d.lookingFor ?? "").trim(),
    canOffer: (d.canOffer ?? "").trim(),
  }));
}

// ---------------------------------------------------------------------------
// /me
// ---------------------------------------------------------------------------

/** Records a sign-in / activity ping (telemetry, not a change — not audited). */
export async function touchActivity(uid: string) {
  const now = new Date();
  await pgdb
    .update(users)
    .set({ lastLoginAt: now, lastActiveAt: now, isActive: true })
    .where(eq(users.uid, uid))
    .catch(() => {});
}

/** True while the user is a table captain in a conclave that is currently running. */
async function isLiveCaptain(uid: string): Promise<boolean> {
  const [row] = await pgdb
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .innerJoin(conclaves, eq(conclaves.id, registrations.conclaveId))
    .where(and(eq(registrations.userId, uid), eq(registrations.role, "captain"), inArray(conclaves.status, ["running", "active"])));
  return (row?.n ?? 0) > 0;
}

export interface MeInput {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

/**
 * The signed-in caller's profile. Admin roles come ONLY from the admins table;
 * a member is "captain" only while captaining a running conclave.
 */
export async function getMe({ uid, email, emailVerified }: MeInput) {
  void touchActivity(uid);

  const [admin] = await pgdb.select().from(admins).where(eq(admins.uid, uid));
  if (admin) {
    return {
      uid,
      id: uid,
      name: admin.name || (admin.role === "superadmin" ? "Superadmin" : "Admin"),
      email: admin.email || email || "",
      phone: admin.phone ?? "",
      region: admin.region ?? "Global",
      role: admin.role,
      createdAt: admin.grantedAt.toISOString(),
    };
  }

  let user = await getUser(uid);
  // Email fallback only for a Firebase-verified email — otherwise anyone could
  // sign up with a member's address and read that member's profile.
  if (!user && email && emailVerified) {
    const e = email.toLowerCase().trim();
    [user] = await pgdb
      .select()
      .from(users)
      .where(or(sql`lower(${users.email}) = ${e}`, sql`lower(${users.identifier}) = ${e}`))
      .limit(1);
  }

  const captain = await isLiveCaptain(uid);
  return {
    uid,
    id: uid,
    name: user?.name || "Member",
    email: user?.email || email || "",
    phone: user?.phone ?? "",
    company: user?.company ?? "",
    category: user?.category ?? "",
    chapter: user?.chapter ?? "",
    location: user?.location ?? "",
    createdAt: (user?.createdAt ?? new Date()).toISOString(),
    role: captain ? "captain" : "member",
    isCaptain: captain,
  };
}

// ---------------------------------------------------------------------------
// Profile update
// ---------------------------------------------------------------------------

export interface UpdateMeInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  mobile?: unknown;
  company?: unknown;
  businessName?: unknown;
  category?: unknown;
  businessCategory?: unknown;
  chapter?: unknown;
  region?: unknown;
  designation?: unknown;
  organization?: unknown;
  membership?: unknown;
  lookingFor?: unknown;
  canOffer?: unknown;
  state?: unknown;
  country?: unknown;
  location?: unknown;
}

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

/**
 * Updates the caller's own profile. For an admin account only the harmless
 * fields (name, phone, designation, organization) are editable — `region` drives
 * regional authorization, so it changes only through the coordinator screen.
 */
export async function updateMe(uid: string, input: UpdateMeInput, signInEmail?: string) {
  const [admin] = await pgdb.select().from(admins).where(eq(admins.uid, uid));
  if (admin) {
    const patch: Partial<typeof admins.$inferInsert> = {};
    if (input.name !== undefined) {
      patch.name = str(input.name);
      if (!patch.name) throw ApiError.badRequest("Name can't be empty.");
    }
    if (input.phone !== undefined || input.mobile !== undefined) patch.phone = normalizePhone(input.phone ?? input.mobile)?.phone ?? null;
    if (input.designation !== undefined) patch.designation = str(input.designation);
    if (input.organization !== undefined) patch.organization = str(input.organization);
    if (!Object.keys(patch).length) throw ApiError.badRequest("Nothing to update.");
    await pgdb.transaction(async (tx) => {
      const [after] = await tx.update(admins).set({ ...patch, updatedAt: new Date() }).where(eq(admins.uid, uid)).returning();
      await audit.change({ action: "admin.update_self", entityType: "admin", entityId: uid, before: admin, after }, tx);
    });
    return { id: uid, ...patch };
  }

  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) {
    patch.name = str(input.name);
    if (!patch.name) throw ApiError.badRequest("Name can't be empty.");
  }
  if (input.email !== undefined) {
    const e = str(input.email).toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw ApiError.badRequest("Enter a valid email.");
    patch.email = e || null;
  }
  if (input.phone !== undefined || input.mobile !== undefined) {
    const p = normalizePhone(input.phone ?? input.mobile);
    patch.phone = p?.phone ?? null;
    // `identifier` is the Firebase sign-in for phone accounts; it follows the phone.
    if (p) patch.identifier = p.identifier;
  }
  if (input.company !== undefined || input.businessName !== undefined) patch.company = str(input.company ?? input.businessName);
  if (input.category !== undefined || input.businessCategory !== undefined) patch.category = str(input.category ?? input.businessCategory);
  if (input.chapter !== undefined) patch.chapter = str(input.chapter) || null;
  if (input.region !== undefined) {
    patch.region = str(input.region) || null;
    if (input.location === undefined) patch.location = patch.region ? patch.region.toLowerCase() : null;
  }
  // Same normalisation as registration: "Guntur", " guntur " group as one place.
  if (input.location !== undefined) patch.location = str(input.location).toLowerCase() || null;
  if (input.designation !== undefined) patch.designation = str(input.designation);
  if (input.membership !== undefined) patch.membership = str(input.membership);
  if (input.lookingFor !== undefined) patch.lookingFor = str(input.lookingFor, 1000);
  if (input.canOffer !== undefined) patch.canOffer = str(input.canOffer, 1000);
  if (input.state !== undefined) patch.state = str(input.state) || null;
  if (input.country !== undefined) patch.country = str(input.country) || null;

  return pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
    const [after] = before
      ? await tx.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.uid, uid)).returning()
      : await tx
          .insert(users)
          // First save after sign-up: the sign-in address comes from the
          // VERIFIED token (synthetic for phone accounts), never the request.
          .values({ uid, country: "India", identifier: signInEmail?.toLowerCase() ?? patch.identifier ?? null, ...patch })
          .returning();
    await audit.change({ action: before ? "user.update" : "user.create", entityType: "user", entityId: uid, before: before ?? null, after }, tx);
    return {
      id: uid,
      name: after.name,
      email: after.email,
      phone: after.phone,
      mobile: after.phone?.slice(-10) ?? "",
      company: after.company,
      businessName: after.company,
      category: after.category,
      businessCategory: after.category,
      chapter: after.chapter,
      region: after.region,
      designation: after.designation,
    };
  });
}

// ---------------------------------------------------------------------------
// Account deletion (App Store Guideline 5.1.1(v))
// ---------------------------------------------------------------------------

/**
 * Deletes the caller's profile and in-app notifications (cascade), then their
 * Firebase login. Event history (registrations, attendance, referrals) is kept
 * as history but no longer resolves to a live account. The audit row records
 * only that it happened — not the deleted personal data.
 */
export async function deleteOwnAccount(uid: string) {
  await pgdb.transaction(async (tx) => {
    const [before] = await tx.delete(users).where(eq(users.uid, uid)).returning();
    await audit.change({ action: "user.delete_self", entityType: "user", entityId: uid, metadata: { hadProfile: !!before } }, tx);
  });
  await auth.deleteUser(uid).catch((e) =>
    console.error(JSON.stringify({ level: "error", msg: "deleteAccount: firebase deleteUser failed", uid, err: (e as Error).message })),
  );
}

// ---------------------------------------------------------------------------
// Sign-in helper (public endpoint)
// ---------------------------------------------------------------------------

/**
 * Maps what a member typed (email or phone) to the Firebase sign-in address.
 *
 * PUBLIC, so it returns ONLY that address — never name, email, uid or role, and
 * no "found" flag (that would let anyone test whether a number is a member).
 */
export async function resolveSignInAddress(rawInput: unknown): Promise<string> {
  const input = String(rawInput ?? "").trim().toLowerCase();
  if (!input) throw ApiError.badRequest("Identifier is required.");
  const digits = input.replace(/\D/g, "");
  const isPhone = !input.includes("@") && digits.length >= 10 && digits.length <= 12;
  const tenDigit = isPhone ? digits.slice(-10) : "";

  const [u] = await pgdb
    .select({ identifier: users.identifier, email: users.email })
    .from(users)
    .where(
      isPhone
        ? or(eq(users.phone, `+91${tenDigit}`), sql`lower(${users.identifier}) = ${`91${tenDigit}${PHONE_ACCOUNT_DOMAIN}`}`)
        : or(sql`lower(${users.email}) = ${input}`, sql`lower(${users.identifier}) = ${input}`),
    )
    .limit(1);

  if (u) return (u.identifier || u.email || input).toLowerCase();
  return isPhone ? `91${tenDigit}${PHONE_ACCOUNT_DOMAIN}` : input;
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

/** Every member for the admin Members page. */
export async function listAllMembersForAdmin() {
  const [rows, adminRows, regRegions] = await Promise.all([
    pgdb.select().from(users).orderBy(asc(users.name)),
    pgdb.select({ uid: admins.uid }).from(admins),
    // A member with no region of their own belongs to the region of the
    // conclave they last registered for.
    pgdb
      .select({ uid: registrations.userId, region: conclaves.region })
      .from(registrations)
      .innerJoin(conclaves, eq(conclaves.id, registrations.conclaveId))
      .orderBy(asc(registrations.registeredAt)),
  ]);
  // Admin accounts get a profile row when they sign in; they are not members.
  const adminUids = new Set(adminRows.map((a) => a.uid));
  const regionByUid = new Map(regRegions.filter((r) => r.region).map((r) => [r.uid, r.region!]));
  return rows.filter((d) => !adminUids.has(d.uid)).map((d) => ({
    id: d.uid,
    name: d.name || "Sign-up not finished",
    company: d.company ?? "",
    category: d.category ?? "",
    region: d.region || regionByUid.get(d.uid) || d.location || "",
    chapter: d.chapter ?? "",
    status: d.lastLoginAt ? "Active" : "Inactive",
    email: d.email ?? "",
    mobile: d.phone ?? "",
  }));
}

/** Admin search by email / phone / sign-in identifier (exact matches). */
export async function findUsers(query: string) {
  const q = query.trim();
  if (q.length < 3) throw ApiError.badRequest("Enter at least 3 characters.");
  const lower = q.toLowerCase();
  let phone: string | null = null;
  if (!q.includes("@") && q.replace(/\D/g, "").length >= 10) {
    try {
      phone = normalizePhone(q)?.phone ?? null;
    } catch {
      phone = null;
    }
  }
  const rows = await pgdb
    .select()
    .from(users)
    .where(
      or(
        sql`lower(${users.email}) = ${lower}`,
        sql`lower(${users.identifier}) = ${lower}`,
        ...(phone ? [eq(users.phone, phone)] : []),
      ),
    )
    .limit(10);
  return rows.map((u) => ({
    uid: u.uid,
    name: u.name,
    /** Their own sign-in address (synthetic for phone accounts). */
    identifier: u.identifier ?? "",
    email: u.email ?? "",
    phone: u.phone ?? "",
    businessName: u.company ?? "",
    businessCategory: u.category ?? "",
  }));
}

/** Member-level roles an admin may set on a profile. Admin roles live in `admins`. */
const MEMBER_ROLES = new Set(["member", "captain"]);

export async function setUserRole(uid: string, role: unknown) {
  const r = String(role ?? "").toLowerCase();
  if (!MEMBER_ROLES.has(r)) {
    throw ApiError.badRequest('role must be "member" or "captain". Admin access is granted from the Coordinators page.');
  }
  await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
    if (!before) throw ApiError.notFound("No such user.");
    const [after] = await tx.update(users).set({ role: r, updatedAt: new Date() }).where(eq(users.uid, uid)).returning();
    await audit.change({ action: "user.set_role", entityType: "user", entityId: uid, before, after }, tx);
  });
}

// ---------------------------------------------------------------------------
// Registrants (a conclave's roster joined with profiles)
// ---------------------------------------------------------------------------

export interface Registrant {
  uid: string;
  role: "captain" | "member";
  registeredAt: string | null;
  name: string;
  phone: string;
  email: string;
  company?: string;
  businessName: string;
  category?: string;
  businessCategory: string;
  chapter?: string;
  region?: string;
  state?: string;
  country?: string;
  location?: unknown;
  tableNumber?: number | null;
  status?: string | null;
  paymentStatus?: string | null;
  payment?: Record<string, unknown> | null;
  createdAt?: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
}

export async function listRegistrants(conclaveId: string): Promise<Registrant[]> {
  const [regs, autoLogoutHours, [conclave]] = await Promise.all([
    pgdb.select().from(registrations).where(eq(registrations.conclaveId, conclaveId)),
    getAutoLogoutHours(),
    pgdb.select({ region: conclaves.region }).from(conclaves).where(eq(conclaves.id, conclaveId)),
  ]);
  const profiles = await fetchUsers(regs.map((r) => r.userId));
  const now = new Date();

  return regs
    .map((reg) => {
      const u = profiles.get(reg.userId);
      // Real contacts first; a phone account's identifier is synthetic and useless to an admin.
      const identifier = u?.identifier && !isSynthetic(u.identifier) ? u.identifier : "";
      const company = u?.company ?? reg.company ?? "";
      const category = u?.category ?? reg.category ?? "";
      return {
        uid: reg.userId,
        role: (reg.role === "captain" ? "captain" : "member") as "captain" | "member",
        registeredAt: reg.registeredAt?.toISOString() ?? null,
        name: u?.name || reg.name || "",
        phone: u?.phone ?? reg.phone ?? "",
        email: u?.email ?? reg.email ?? identifier,
        company,
        businessName: company,
        category,
        businessCategory: category,
        chapter: u?.chapter ?? reg.chapter ?? "",
        region: u?.region || reg.region || conclave?.region || "",
        tableNumber: reg.tableNumber ?? null,
        status: reg.status ?? null,
        paymentStatus: reg.paymentStatus ?? null,
        payment: reg.payment ?? null,
        state: u?.state ?? reg.state ?? "",
        country: u?.country ?? reg.country ?? "",
        location: u?.location ?? "",
        createdAt: (u?.createdAt ?? reg.registeredAt)?.toISOString() ?? null,
        isActive: isActiveUser(u, autoLogoutHours, now),
        lastLoginAt: u?.lastLoginAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Own profile (the app's Profile screen) and profile photo
// ---------------------------------------------------------------------------

/** The caller's full profile — including their own contact details. */
export async function getOwnProfile(uid: string) {
  const u = await getUser(uid);
  if (!u) return null;
  return {
    uid: u.uid,
    name: u.name,
    /** Their own sign-in address (synthetic for phone accounts). */
    identifier: u.identifier ?? "",
    email: u.email ?? "",
    phone: u.phone ?? "",
    mobile: u.phone?.slice(-10) ?? "",
    company: u.company ?? "",
    businessName: u.company ?? "",
    category: u.category ?? "",
    businessCategory: u.category ?? "",
    chapter: u.chapter ?? "",
    region: u.region ?? "",
    state: u.state ?? "",
    country: u.country ?? "",
    location: u.location ?? "",
    designation: u.designation ?? "",
    membership: u.membership ?? "",
    lookingFor: u.lookingFor ?? "",
    canOffer: u.canOffer ?? "",
    photoUrl: u.photoUrl ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_MAX = 5 * 1024 * 1024;

/** Replace the caller's profile photo (stored in Blob Storage), audited. */
export async function setPhoto(uid: string, dataUrl: unknown) {
  const { decodeDataUrl, uploadFile, deleteFile } = await import("./storage.service.js");
  const { contentType, data } = decodeDataUrl(String(dataUrl ?? ""));
  if (!PHOTO_TYPES.has(contentType)) throw ApiError.badRequest("Profile photos must be JPEG, PNG or WebP.");
  if (data.length > PHOTO_MAX) throw ApiError.badRequest("Profile photos must be 5 MB or smaller.");
  const stored = await uploadFile("avatars", `profile.${contentType.split("/")[1]}`, contentType, data);

  const previous = await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
    if (!before) throw ApiError.notFound("Create your profile first.");
    const [after] = await tx
      .update(users)
      .set({ photoUrl: stored.url, legacy: { ...before.legacy, photoPath: stored.path }, updatedAt: new Date() })
      .where(eq(users.uid, uid))
      .returning();
    await audit.change({ action: "user.photo_set", entityType: "user", entityId: uid, before: { photoUrl: before.photoUrl }, after: { photoUrl: after.photoUrl } }, tx);
    return before.legacy?.photoPath as string | undefined;
  });
  if (previous) await deleteFile(previous);
  return { photoUrl: stored.url };
}

export async function removePhoto(uid: string) {
  const { deleteFile } = await import("./storage.service.js");
  const previous = await pgdb.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.uid, uid)).for("update");
    if (!before) throw ApiError.notFound("No profile.");
    const { photoPath, ...rest } = before.legacy ?? {};
    await tx.update(users).set({ photoUrl: null, legacy: rest, updatedAt: new Date() }).where(eq(users.uid, uid));
    await audit.change({ action: "user.photo_remove", entityType: "user", entityId: uid, before: { photoUrl: before.photoUrl }, after: { photoUrl: null } }, tx);
    return photoPath as string | undefined;
  });
  if (previous) await deleteFile(previous);
}
