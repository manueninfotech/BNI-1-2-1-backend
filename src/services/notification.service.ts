import { messaging } from "../config/firebase.js";

export const conclaveTopic = (conclaveId: string) => `conclave_${conclaveId}`;

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
