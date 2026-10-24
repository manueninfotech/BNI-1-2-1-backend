import { and, asc, eq, gte, lte, or, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { oneToOnes, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";
import { runAsSystem } from "../observability/context.js";
import { displayName, fetchUsers } from "./user.service.js";
import { notifyUser, recordUserNotification, sendDataToUser } from "./notification.service.js";

/**
 * 1-2-1 meeting requests between members. The uid always comes from the token,
 * so a member acts only on their own. Every create / response / cancel is
 * audited.
 *
 * Status machine: pending → accepted | declined (invitee only);
 *                 pending | accepted → cancelled (either party).
 */

const NEXT: Record<string, Set<string>> = {
  pending: new Set(["accepted", "declined", "cancelled"]),
  accepted: new Set(["cancelled"]),
  declined: new Set(),
  cancelled: new Set(),
};
const PAST_SLACK_MS = 5 * 60_000;
const MONTH_MS = 30 * 86_400_000;

export async function create(uid: string, input: { toUserId?: unknown; proposedAt?: unknown; location?: unknown; note?: unknown }) {
  const toUserId = String(input.toUserId ?? "").trim();
  const proposedAt = new Date(String(input.proposedAt ?? ""));
  const location = String(input.location ?? "").trim().slice(0, 300);
  const note = String(input.note ?? "").trim().slice(0, 1000);

  if (!toUserId) throw ApiError.badRequest("Choose a member.");
  if (toUserId === uid) throw ApiError.badRequest("You can't book a 1-2-1 with yourself.");
  if (Number.isNaN(proposedAt.getTime())) throw ApiError.badRequest("Pick a valid date and time.");
  if (proposedAt.getTime() < Date.now() - PAST_SLACK_MS) throw ApiError.badRequest("Pick a time in the future.");

  const id = await pgdb.transaction(async (tx) => {
    // Serialise requests between the same pair so the anti-spam checks can't race.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`121:${uid}:${toUserId}`}))`);
    const [target] = await tx.select({ uid: users.uid }).from(users).where(eq(users.uid, toUserId));
    if (!target) throw ApiError.notFound("Member not found.");

    const prior = await tx
      .select({ status: oneToOnes.status, createdAt: oneToOnes.createdAt })
      .from(oneToOnes)
      .where(and(eq(oneToOnes.fromUserId, uid), eq(oneToOnes.toUserId, toUserId)));
    if (prior.some((p) => p.status === "pending")) {
      throw ApiError.conflict("You already have a pending 1-2-1 request with this member.");
    }
    if (prior.filter((p) => p.createdAt.getTime() >= Date.now() - MONTH_MS).length >= 2) {
      throw new ApiError(429, "You can request a 1-2-1 with the same member at most twice a month.");
    }

    const [row] = await tx.insert(oneToOnes).values({ fromUserId: uid, toUserId, proposedAt, location, note }).returning();
    await audit.change({ action: "one_to_one.create", entityType: "one_to_one", entityId: row.id, after: row }, tx);
    return row.id;
  });

  // Data-only push → the app shows Accept / Decline actions in the tray.
  const fromName = await displayName(uid);
  void sendDataToUser(toUserId, { type: "one_to_one_request", id, fromName });
  void recordUserNotification(toUserId, {
    title: "New 1-2-1 request",
    body: `${fromName} wants a one-to-one with you.`,
    type: "one_to_one_request",
    data: { id },
  });
  return { id };
}

export async function listMine(uid: string) {
  const rows = await pgdb
    .select()
    .from(oneToOnes)
    .where(or(eq(oneToOnes.fromUserId, uid), eq(oneToOnes.toUserId, uid)))
    .orderBy(asc(oneToOnes.proposedAt));
  const people = await fetchUsers(rows.map((r) => (r.fromUserId === uid ? r.toUserId : r.fromUserId)));
  return {
    oneToOnes: rows.map((r) => {
      const sent = r.fromUserId === uid;
      const otherUserId = sent ? r.toUserId : r.fromUserId;
      const u = people.get(otherUserId);
      return {
        id: r.id,
        direction: sent ? "sent" : "received",
        otherUserId,
        otherName: u?.name ?? "",
        otherBusinessName: u?.company ?? "",
        otherPhotoUrl: u?.photoUrl ?? null,
        proposedAt: r.proposedAt.toISOString(),
        location: r.location,
        note: r.note,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  };
}

export async function respond(uid: string, id: string, statusInput: unknown) {
  const status = String(statusInput ?? "").trim();
  if (!["accepted", "declined", "cancelled"].includes(status)) throw ApiError.badRequest("Invalid status.");

  const { before } = await pgdb.transaction(async (tx) => {
    const [b] = await tx.select().from(oneToOnes).where(eq(oneToOnes.id, id)).for("update");
    if (!b) throw ApiError.notFound("1-2-1 not found.");
    const isReceiver = b.toUserId === uid;
    const isSender = b.fromUserId === uid;
    if (!isReceiver && !isSender) throw ApiError.forbidden("Not your 1-2-1.");
    if ((status === "accepted" || status === "declined") && !isReceiver) throw ApiError.forbidden("Only the invited member can respond.");
    if (!NEXT[b.status]?.has(status)) throw ApiError.conflict(`This 1-2-1 is already ${b.status}.`);
    const [after] = await tx.update(oneToOnes).set({ status, updatedAt: new Date() }).where(eq(oneToOnes.id, id)).returning();
    await audit.change({ action: `one_to_one.${status}`, entityType: "one_to_one", entityId: id, before: b, after }, tx);
    return { before: b };
  });

  // Tell the OTHER party.
  const actorName = await displayName(uid);
  const target = status === "cancelled" ? (before.fromUserId === uid ? before.toUserId : before.fromUserId) : before.fromUserId;
  const msg =
    status === "cancelled"
      ? { title: "1-2-1 cancelled", body: `${actorName} cancelled a 1-2-1.`, data: { type: "one_to_one", id } }
      : { title: `1-2-1 ${status}`, body: `${actorName} ${status} your 1-2-1 request.`, data: { type: "one_to_one", id } };
  void notifyUser(target, msg, "one_to_ones");
  void recordUserNotification(target, { ...msg, type: "one_to_one" });
  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** How far ahead of a meeting the reminder fires. */
const WINDOW_MS = 60 * 60_000;

/**
 * Sends the "your 1-2-1 is coming up" reminder for accepted meetings starting
 * within the next hour. Each meeting is CLAIMED atomically (UPDATE … RETURNING
 * flips reminder_sent), so with several instances each reminder goes out once.
 */
export async function sweepReminders(now = new Date()): Promise<number> {
  const due = await pgdb
    .update(oneToOnes)
    .set({ reminderSent: true })
    .where(
      and(
        eq(oneToOnes.status, "accepted"),
        eq(oneToOnes.reminderSent, false),
        gte(oneToOnes.proposedAt, now),
        lte(oneToOnes.proposedAt, new Date(now.getTime() + WINDOW_MS)),
      ),
    )
    .returning();

  for (const m of due) {
    const [fromName, toName] = await Promise.all([displayName(m.fromUserId), displayName(m.toUserId)]);
    const base = { type: "one_to_one_reminder", id: m.id, proposedAt: m.proposedAt.toISOString(), location: m.location };
    await sendDataToUser(m.fromUserId, { ...base, otherName: toName }).catch(() => {});
    await sendDataToUser(m.toUserId, { ...base, otherName: fromName }).catch(() => {});
  }
  if (due.length) await audit.system("one_to_one.reminders_sent", { count: due.length, ids: due.map((d) => d.id) });
  return due.length;
}

/** In-process scheduler: once on boot, then every 5 minutes. */
export function startReminderScheduler(): void {
  const run = () =>
    runAsSystem("one-to-one-reminders", () => sweepReminders()).catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "1-2-1 reminder sweep failed", err: (e as Error).message })),
    );
  void run();
  setInterval(run, 5 * 60_000);
}
