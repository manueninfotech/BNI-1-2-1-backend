import type { DocumentReference } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

/**
 * Fetch many documents in as few round trips as possible.
 *
 * The obvious `for (id of ids) await get(id)` costs one network round trip per
 * document — 300 of them for a real conclave, on endpoints the dashboard polls.
 * `getAll` batches them into a single RPC.
 */
export async function getAllDocs<T = FirebaseFirestore.DocumentData>(
  refs: DocumentReference[],
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (refs.length === 0) return out;

  // Chunked so a very large conclave can't blow the request size limit.
  const CHUNK = 200;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const docs = await db.getAll(...refs.slice(i, i + CHUNK));
    for (const d of docs) {
      if (d.exists) out.set(d.id, d.data() as T);
    }
  }
  return out;
}

/** Firestore Timestamp | Date | ISO string -> Date. */
export function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === "function" ? maybe.toDate() : null;
}

export const toIso = (v: unknown): string | null => toDate(v)?.toISOString() ?? null;
