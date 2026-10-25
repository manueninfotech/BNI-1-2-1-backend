import { and, desc, eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { notifications, users } from "../db/schema.js";

/**
 * The in-app notification inbox (history + unread count), separate from the
 * transient FCM push. Not audited row-by-row: an inbox entry is itself a record
 * of something that was already audited (a 1-2-1 request, a round start…).
 */

export interface InboxNotification {
  title: string;
  body: string;
  type: string;
  data?: Record<string, string>;
}

/** Adds an entry to a member's inbox. Best-effort: never fails the caller. */
export async function record(uid: string, n: InboxNotification): Promise<void> {
  if (!uid) return;
  try {
    // Insert only for an existing profile (FK) — a deleted account gets nothing.
    await pgdb.execute(sql`
      INSERT INTO ${notifications} (user_id, title, body, type, data)
      SELECT ${uid}, ${n.title}, ${n.body}, ${n.type}, ${JSON.stringify(n.data ?? {})}::jsonb
      WHERE EXISTS (SELECT 1 FROM ${users} WHERE uid = ${uid})`);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "record notification failed", uid, err: (e as Error).message }));
  }
}

/** Latest 50, newest first, with the unread count across ALL of the member's notifications. */
export async function listForUser(uid: string) {
  const [rows, [{ unread }]] = await Promise.all([
    pgdb.select().from(notifications).where(eq(notifications.userId, uid)).orderBy(desc(notifications.createdAt)).limit(50),
    pgdb
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, uid), eq(notifications.read, false))),
  ]);
  return {
    notifications: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      type: n.type,
      data: n.data,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
    })),
    unreadCount: unread,
  };
}

/** Marks every unread notification read; returns how many changed. */
export async function markAllRead(uid: string): Promise<number> {
  const updated = await pgdb
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, uid), eq(notifications.read, false)))
    .returning({ id: notifications.id });
  return updated.length;
}
