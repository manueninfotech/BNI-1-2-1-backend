import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Per-request (or per-job) context, available anywhere in the call chain
 * without threading it through every function signature. The audit trail and
 * the logs read it, so every record carries the same request id and actor.
 */
export type Source = "mobile_app" | "admin_panel" | "webhook" | "system" | "script" | "unknown";

export interface Actor {
  uid: string | null;
  role: string; // member | captain | coordinator | admin | superadmin | system | webhook | anonymous
  email?: string | null;
  name?: string | null;
}

export interface RequestContext {
  requestId: string;
  source: Source;
  actor: Actor;
  ip?: string | null;
  userAgent?: string | null;
  /** Set when a service recorded a domain change, so the request row can link to it. */
  changeCount: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const ANONYMOUS: Actor = { uid: null, role: "anonymous" };
export const SYSTEM: Actor = { uid: null, role: "system" };

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Called by the auth middleware once the caller is known. */
export function setActor(actor: Actor) {
  const ctx = storage.getStore();
  if (ctx) ctx.actor = actor;
}

export const newRequestId = () => randomUUID();

/**
 * Runs a scheduled job or script with a "system" actor, so anything it audits
 * is attributed to the job rather than to nobody.
 */
export function runAsSystem<T>(job: string, fn: () => Promise<T>, source: Source = "system"): Promise<T> {
  return storage.run(
    { requestId: `${source}:${job}:${newRequestId()}`, source, actor: { ...SYSTEM, name: job }, changeCount: 0 },
    fn,
  );
}
