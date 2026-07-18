import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";

export async function register(req: AuthedRequest, res: Response) {
  const result = await registration.register(req.params.id, req.uid);
  res.json({
    message: result.alreadyRegistered ? "You are already registered." : "Registered.",
    ...result,
  });
}

export async function syncConclave(req: AuthedRequest, res: Response) {
  // Taken BEFORE the Firestore work, which takes seconds. The client uses it to
  // correct its clock; stamping it at response time would make it mistake our
  // processing time for network latency.
  const serverReceivedAt = Date.now();

  const result = await sync.syncConclave(
    req.params.id,
    req.uid, // from the verified token — NEVER from the body
    req.body ?? {},
    serverReceivedAt,
  );

  res.json(result);
}
