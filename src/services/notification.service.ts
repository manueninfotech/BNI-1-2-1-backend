import { messaging } from "../config/firebase.js";

export const conclaveTopic = (conclaveId: string) => `conclave_${conclaveId}`;
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
): Promise<boolean> {
  if (!uid) return false;
  try {
    await messaging.send({
      topic: userTopic(uid),
      notification: { title: msg.title, body: msg.body },
      data: msg.data ?? {},
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return true;
  } catch (e) {
    console.error(`FCM notifyUser failed for ${uid}:`, (e as Error).message);
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
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return true;
  } catch (e) {
    console.error(`FCM notify failed for ${conclaveId}:`, (e as Error).message);
    return false;
  }
}
