import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Read side of the audit trail, for the admin panel's activity log.
 * Newest first, keyset-paginated by id (stable under concurrent inserts).
 */
export interface AuditQuery {
  actorUid?: string;
  conclaveId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  kind?: string;
  source?: string;
  outcome?: string;
  requestId?: string;
  from?: string;
  to?: string;
  /** Return rows with id < cursor (the `nextCursor` of the previous page). */
  cursor?: string;
  limit?: string;
}

const FILTERS = ["actorUid", "conclaveId", "entityType", "entityId", "action", "kind", "source", "outcome", "requestId"] as const;

function parseDate(v: string | undefined, name: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${name} must be an ISO date.`);
  return d;
}

export async function queryAudit(q: AuditQuery) {
  const where: SQL[] = [];
  for (const f of FILTERS) {
    const v = q[f];
    if (typeof v === "string" && v) where.push(eq(auditLog[f], v.slice(0, 200)));
  }
  const from = parseDate(q.from, "from");
  const to = parseDate(q.to, "to");
  if (from) where.push(gte(auditLog.occurredAt, from));
  if (to) where.push(lte(auditLog.occurredAt, to));
  if (q.cursor) {
    const c = Number(q.cursor);
    if (!Number.isInteger(c) || c <= 0) throw ApiError.badRequest("cursor is invalid.");
    where.push(lt(auditLog.id, c));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);

  const rows = await pgdb
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    items: page,
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}
