import { pgdb, type Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { currentContext, ANONYMOUS } from "../observability/context.js";

/**
 * The audit trail API used by the rest of the backend.
 *
 *   await audit.change({ action: "conclave.update", entityType: "conclave",
 *                        entityId: id, before, after }, tx);
 *
 * Actor, request id, source, IP and user agent come from the request context
 * automatically. Pass the transaction (`tx`) when the change itself is written
 * in one, so the change and its audit row commit or roll back together.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

// ---------------------------------------------------------------------------
// Redaction — secrets and bulky payloads never reach the audit table.
// ---------------------------------------------------------------------------

const SENSITIVE = /pass(word)?|token|secret|signature|otp|authorization|cookie|api[-_]?key|cvv|card(number)?|private[-_]?key/i;
const BULKY = /dataurl|base64|rawbody|file$/i;
const MAX_STRING = 1000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0, key = ""): unknown {
  if (key && SENSITIVE.test(key)) return value == null ? value : "[redacted]";
  if (key && BULKY.test(key)) return value == null ? value : "[omitted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (value.startsWith("data:")) return "[omitted data url]";
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : value;
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY} items]`);
    return out;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, redact(v, depth + 1, k)]));
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Diff — field-level before → after for change rows.
// ---------------------------------------------------------------------------

/** Fields that change on every write and carry no meaning in a diff. */
const NOISE = new Set(["updatedAt", "updated_at", "syncedAt", "synced_at", "legacy"]);

export function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, { from: unknown; to: unknown }> | null {
  const b = before ?? {};
  const a = after ?? {};
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (NOISE.has(k)) continue;
    const from = redact(b[k], 0, k);
    const to = redact(a[k], 0, k);
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out[k] = { from: from ?? null, to: to ?? null };
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function contextFields() {
  const ctx = currentContext();
  const actor = ctx?.actor ?? ANONYMOUS;
  return {
    requestId: ctx?.requestId ?? null,
    actorUid: actor.uid,
    actorRole: actor.role,
    actorEmail: actor.email ?? null,
    actorName: actor.name ?? null,
    source: ctx?.source ?? "unknown",
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
  };
}

export interface ChangeInput {
  /** dotted verb, e.g. "conclave.update", "registration.create", "admin.grant" */
  action: string;
  entityType: string;
  entityId?: string | null;
  conclaveId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records a domain change. Inside a transaction, pass `tx`: if the audit write
 * fails, the change fails with it — an unaudited change never commits.
 */
async function change(input: ChangeInput, exec: Executor = pgdb) {
  const ctx = currentContext();
  if (ctx) ctx.changeCount++;
  const isCreate = !input.before && !!input.after;
  const isDelete = !!input.before && !input.after;
  await exec.insert(auditLog).values({
    ...contextFields(),
    kind: ctx?.source === "system" || ctx?.source === "script" ? "system" : "change",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    conclaveId: input.conclaveId ?? (input.entityType === "conclave" ? input.entityId ?? null : null),
    changes: diff(input.before, input.after),
    metadata: redact({
      ...(input.metadata ?? {}),
      ...(isCreate ? { op: "create" } : isDelete ? { op: "delete" } : {}),
    }) as Record<string, unknown>,
  });
}

export interface RequestInput {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  entityId?: string | null;
  conclaveId?: string | null;
  body?: unknown;
  query?: unknown;
  error?: string | null;
}

/**
 * Records one API call. Never throws: a failure to write the request row is
 * logged, not surfaced, because the response has already been sent.
 */
async function request(input: RequestInput) {
  const outcome = input.statusCode === 401 || input.statusCode === 403
    ? "denied"
    : input.statusCode >= 400 ? "failure" : "success";
  try {
    await pgdb.insert(auditLog).values({
      ...contextFields(),
      kind: "request",
      action: `http.${input.method}`,
      method: input.method,
      route: input.route,
      entityId: input.entityId ?? null,
      conclaveId: input.conclaveId ?? null,
      statusCode: input.statusCode,
      outcome,
      error: input.error ?? null,
      durationMs: Math.round(input.durationMs),
      metadata: redact({
        ...(input.body && Object.keys(input.body as object).length ? { body: input.body } : {}),
        ...(input.query && Object.keys(input.query as object).length ? { query: input.query } : {}),
        changes: currentContext()?.changeCount ?? 0,
      }) as Record<string, unknown>,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "audit request write failed", requestId: currentContext()?.requestId, err: (err as Error).message }),
    );
  }
}

/** A system event outside any HTTP request (job run, script, startup). */
async function system(action: string, metadata: Record<string, unknown> = {}, exec: Executor = pgdb) {
  await exec.insert(auditLog).values({
    ...contextFields(),
    kind: "system",
    action,
    metadata: redact(metadata) as Record<string, unknown>,
  });
}

export const audit = { change, request, system };
