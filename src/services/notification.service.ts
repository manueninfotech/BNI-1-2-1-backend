import { messaging, db, collections } from "../config/firebase.js";

export const conclaveTopic = (conclaveId: string) => `conclave_${conclaveId}`;

/**
 * Writes a notification into the member's inbox (`users/{uid}/notifications`),
 * so the in-app notification hub has a history and an unread count — separate
 * from the transient FCM push. Best-effort.
 */
export async function recordUserNotification(
  uid: string,
  n: { title: string; body: string; type: string; data?: Record<string, string> },
): Promise<void> {
  if (!uid) return;
  try {
    await db
      .collection(collections.users)
      .doc(uid)
      .collection("notifications")
      .add({
        title: n.title,
        body: n.body,
        type: n.type,
        data: n.data ?? {},
        read: false,
        createdAt: new Date().toISOString(),
      });
  } catch (e) {
    console.error(`Record notification failed for ${uid}:`, (e as Error).message);
  }
}
export const userTopic = (uid: string) => `user_${uid}`;

/**
 * Push a notification to ONE member, via the per-user FCM topic their app
 * subscribes to on sign-in. Event-driven — fired the moment something happens
 * (a 1-2-1 request, a response) — so no scheduler is involved.
 *
 * Best-effort: a failed push never fails the request that triggered it.
 */
export async function notifyUser(
  uid: string,
  msg: { title: string; body: string; data?: Record<string, string> },
  channelId = "general",
): Promise<boolean> {
  if (!uid) return false;
  try {
    await messaging.send({
      topic: userTopic(uid),
      notification: { title: msg.title, body: msg.body },
      data: msg.data ?? {},
      android: { priority: "high", notification: { channelId } },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return true;
  } catch (e) {
    console.error(`FCM notifyUser failed for ${uid}:`, (e as Error).message);
    return false;
  }
}

/**
 * Data-only push to one member. No `notification` payload, so the app's
 * background handler receives the data and builds the notification itself — used
 * for the sticky, self-counting-down 1-2-1 reminder.
 */
export async function sendDataToUser(
  uid: string,
  data: Record<string, string>,
): Promise<boolean> {
  if (!uid) return false;
  try {
    await messaging.send({
      topic: userTopic(uid),
      data,
      android: { priority: "high" },
      apns: {
        headers: { "apns-priority": "5", "apns-push-type": "background" },
        payload: { aps: { "content-available": 1 } },
      },
    });
    return true;
  } catch (e) {
    console.error(`FCM sendDataToUser failed for ${uid}:`, (e as Error).message);
    return false;
  }
}

/**
 * Push a notification to everyone in a conclave, via the FCM topic the app
 * subscribes to when it opens that conclave.
 *
 * Best-effort by design: a failure here must never fail the round. The app reads
 * round state from the conclave document, so a missed notification costs a nudge,
 * not correctness — which matters at a venue where phones may have no signal to
 * receive a push in the first place.
 */
export async function notifyConclave(
  conclaveId: string,
  msg: { title: string; body: string; data?: Record<string, string> },
): Promise<boolean> {
  try {
    await messaging.send({
      topic: conclaveTopic(conclaveId),
      notification: { title: msg.title, body: msg.body },
      data: msg.data ?? {},
      android: { priority: "high", notification: { channelId: "round_alerts" } },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return true;
  } catch (e) {
    console.error(`FCM notify failed for ${conclaveId}:`, (e as Error).message);
    return false;
  }
}
