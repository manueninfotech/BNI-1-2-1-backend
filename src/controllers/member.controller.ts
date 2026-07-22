import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { db, collections } from "../config/firebase.js";
import * as registration from "../services/registration.service.js";
import * as sync from "../services/sync.service.js";
import { listConclaves as listConclaveRecords } from "../services/conclave.service.js";

export async function me(req: AuthedRequest, res: Response) {
  const userDoc = await db.collection(collections.users).doc(req.uid).get();
  const data = userDoc.data() as any;

  res.json({
    uid: req.uid,
    id: req.uid,
    name: data?.name || "",
    email: data?.email || "",
    phone: data?.phone || "",
    company: data?.businessName || "",
    category: data?.businessCategory || "",
    chapter: data?.chapter || "",
    location: data?.location || "",
    role: "member",
  });
}

export async function listConclaves(req: AuthedRequest, res: Response) {
  const list = await listConclaveRecords();

  const registeredSet = new Set<string>();
  await Promise.all(
    list.map(async (c) => {
      const regDoc = await db
        .collection(collections.conclaves)
        .doc(c.id)
        .collection(collections.registrations)
        .doc(req.uid)
        .get();
      if (regDoc.exists) {
        registeredSet.add(c.id);
      }
    }),
  );

  const out = list.map((c) => ({
    ...c,
    isRegistered: registeredSet.has(c.id),
  }));

  res.json(out);
}

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
