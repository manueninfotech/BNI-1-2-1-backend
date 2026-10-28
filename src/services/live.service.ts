import type { Response } from "express";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { pgdb } from "../db/client.js";
import { conclaves } from "../db/schema.js";

/**
 * Live conclave state for the app (replaces Firestore snapshot listeners).
 *
 * Every conclave change runs `pg_notify('conclave_changed', id)` inside its
 * transaction, so the notification fires only on commit. Each server instance
 * holds ONE listening connection and fans the change out to the phones
 * connected to it over Server-Sent Events. No Redis, no extra service.
 */

const CHANNEL = "conclave_changed";
const HEARTBEAT_MS = 25_000; // under Azure's ingress idle timeout

/** Called inside a conclave transaction; delivered when it commits. */
export function notifyConclaveChanged(tx: { execute: (q: any) => Promise<unknown> }, conclaveId: string) {
  return tx.execute(sql`SELECT pg_notify(${CHANNEL}, ${conclaveId})`);
}

/** The compact live state a phone needs (no schedule blob — that's GET /conclaves/:id). */
export async function liveState(id: string) {
  const [c] = await pgdb
    .select({
      id: conclaves.id,
      status: conclaves.status,
      currentRound: conclaves.currentRound,
      roundCount: conclaves.roundCount,
      currentRoundStartedAt: conclaves.currentRoundStartedAt,
      isRoundPaused: conclaves.isRoundPaused,
      roundPausedAt: conclaves.roundPausedAt,
      roundElapsedMsBeforePause: conclaves.roundElapsedMsBeforePause,
      // Round clock inputs, so phones run exactly the server's clock.
      personsPerTable: conclaves.personsPerTable,
      roundProgressionMode: conclaves.roundProgressionMode,
      roundExtensionSeconds: conclaves.roundExtensionSeconds,
      moveSeconds: conclaves.moveSeconds,
      isScheduleLocked: conclaves.isScheduleLocked,
      isRegistrationOpen: conclaves.isRegistrationOpen,
      updatedAt: conclaves.updatedAt,
    })
    .from(conclaves)
    .where(eq(conclaves.id, id));
  if (!c) return null;
  return {
    ...c,
    currentRoundStartedAt: c.currentRoundStartedAt?.toISOString() ?? null,
    roundPausedAt: c.roundPausedAt?.toISOString() ?? null,
    updatedAt: c.updatedAt.toISOString(),
    serverTime: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// One LISTEN connection per instance, fanned out to SSE subscribers
// ---------------------------------------------------------------------------

const subscribers = new Map<string, Set<Response>>();
let listener: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function ensureListener() {
  if (listener) return;
  connecting ??= (async () => {
    const client = new pg.Client({
      connectionString: env.databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl) ? false : { rejectUnauthorized: true },
    });
    client.on("notification", (msg) => {
      if (msg.channel === CHANNEL && msg.payload) void broadcast(msg.payload);
    });
    client.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", msg: "live listener error", err: err.message }));
      listener = null;
      connecting = null;
      setTimeout(() => void ensureListener().catch(() => {}), 2_000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
  })().finally(() => {
    connecting = null;
  });
  await connecting;
}

async function broadcast(conclaveId: string) {
  const subs = subscribers.get(conclaveId);
  if (!subs?.size) return;
  const state = await liveState(conclaveId).catch(() => null);
  if (!state) return;
  const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of subs) res.write(frame);
}

/** Opens an SSE stream for one conclave: current state now, then every change. */
export async function subscribe(conclaveId: string, res: Response): Promise<void> {
  await ensureListener();
  const state = await liveState(conclaveId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);

  const set = subscribers.get(conclaveId) ?? new Set<Response>();
  set.add(res);
  subscribers.set(conclaveId, set);
  const beat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

  res.on("close", () => {
    clearInterval(beat);
    set.delete(res);
    if (!set.size) subscribers.delete(conclaveId);
  });
}

/** Test hook. */
export async function closeListener() {
  const l = listener;
  listener = null;
  await l?.end().catch(() => {});
}
