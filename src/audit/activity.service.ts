import { and, desc, eq, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { admins, auditLog, conclaves, users } from "../db/schema.js";
import { ApiError } from "../middleware/errors.js";
import { regionScope } from "../middleware/conclaveAccess.js";
import { normRegion } from "../services/conclave.service.js";
import type { AdminRecord } from "../services/admins.service.js";

/**
 * The admin panel's Activity page: who changed what, newest first.
 *
 * - Only changes and automatic (system) events; raw HTTP request rows are
 *   left out unless asked for.
 * - A regional admin sees activity on their region's conclaves plus their
 *   own actions. A superadmin sees everything.
 * - Each row carries readable names (who did it, which conclave, which
 *   member), so the page can say "Ganesh removed Asha from LTRT".
 * - IP address and device are shown to superadmins only.
 */
export interface ActivityQuery {
  conclaveId?: string;
  actorUid?: string;
  includeRequests?: string;
  cursor?: string;
  limit?: string;
}

export async function listActivity(admin: AdminRecord | undefined, q: ActivityQuery) {
  if (!admin) throw ApiError.forbidden("Admins only.");
  const where: SQL[] = [];
  if (q.includeRequests !== "true") where.push(ne(auditLog.kind, "request"));
  if (q.conclaveId) where.push(eq(auditLog.conclaveId, String(q.conclaveId).slice(0, 100)));
  if (q.actorUid) where.push(eq(auditLog.actorUid, String(q.actorUid).slice(0, 200)));
  if (q.cursor) {
    const c = Number(q.cursor);
    if (!Number.isInteger(c) || c <= 0) throw ApiError.badRequest("cursor is invalid.");
    where.push(lt(auditLog.id, c));
  }

  const scope = regionScope(admin);
  if (scope !== null) {
    const all = await pgdb.select({ id: conclaves.id, region: conclaves.region }).from(conclaves);
    const mine = all.filter((c) => scope !== "__none__" && normRegion(c.region) === normRegion(scope)).map((c) => c.id);
    const own = eq(auditLog.actorUid, admin.uid);
    where.push(mine.length ? (or(inArray(auditLog.conclaveId, mine), own) as SQL) : own);
  }

  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = await pgdb
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  // Names for everyone and everything mentioned on this page.
  const uidOf = (r: (typeof page)[number]) =>
    r.entityType === "registration" ? r.entityId?.split(":")[1] : r.entityType === "user" || r.entityType === "admin" ? r.entityId : null;
  const uids = [...new Set(page.flatMap((r) => [r.actorUid, uidOf(r)]).filter((x): x is string => !!x))];
  const cids = [...new Set(page.map((r) => r.conclaveId ?? (r.entityType === "conclave" ? r.entityId : null)).filter((x): x is string => !!x))];
  const [userRows, adminRows, conclaveRows] = await Promise.all([
    uids.length ? pgdb.select({ uid: users.uid, name: users.name }).from(users).where(inArray(users.uid, uids)) : [],
    uids.length ? pgdb.select({ uid: admins.uid, name: admins.name }).from(admins).where(inArray(admins.uid, uids)) : [],
    cids.length ? pgdb.select({ id: conclaves.id, name: conclaves.name }).from(conclaves).where(inArray(conclaves.id, cids)) : [],
  ]);
  const nameOf = new Map<string, string>();
  for (const u of userRows) if (u.name) nameOf.set(u.uid, u.name);
  for (const a of adminRows) if (a.name) nameOf.set(a.uid, a.name);
  const conclaveName = new Map(conclaveRows.map((c) => [c.id, c.name]));
  const isSuper = admin.role === "superadmin";

  return {
    items: page.map((r) => {
      const subjectUid = uidOf(r);
      const cid = r.conclaveId ?? (r.entityType === "conclave" ? r.entityId : null);
      return {
        id: r.id,
        occurredAt: r.occurredAt,
        kind: r.kind,
        action: r.action,
        outcome: r.outcome,
        source: r.source,
        actor: {
          uid: r.actorUid,
          role: r.actorRole,
          name: r.actorName || (r.actorUid ? nameOf.get(r.actorUid) : null) || r.actorEmail || null,
        },
        conclave: cid ? { id: cid, name: conclaveName.get(cid) ?? null } : null,
        subject: subjectUid ? { uid: subjectUid, name: nameOf.get(subjectUid) ?? null } : null,
        entityType: r.entityType,
        entityId: r.entityId,
        changes: r.changes,
        metadata: r.metadata,
        requestId: r.requestId,
        ...(isSuper ? { ip: r.ip, userAgent: r.userAgent } : {}),
      };
    }),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}
