import { asc, eq, sql } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves, regions, users } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";
import { ApiError } from "../middleware/errors.js";

/**
 * Regions managed by the superadmin (the `regions` table), with live counts of
 * conclaves and members in each. Every write is audited.
 *
 * (There is also a simple `regions` settings list used by the conclave form;
 * the two will be merged in the admin-panel simplification.)
 */

const DEFAULT_REGIONS = ["Guntur Region", "Vijayawada Region", "Visakhapatnam Region", "Singapore Metro"];
const STATUSES = new Set(["Active", "Inactive"]);

export interface RegionView {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  conclavesCount: number;
  membersCount: number;
}

function cleanName(v: unknown): string {
  const name = String(v ?? "").trim();
  if (!name) throw ApiError.badRequest("Region name is required.");
  if (name.length > 100) throw ApiError.badRequest("Region name is too long (max 100 characters).");
  return name;
}
function cleanStatus(v: unknown, fallback = "Active"): string {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v);
  if (!STATUSES.has(s)) throw ApiError.badRequest(`status must be one of: ${[...STATUSES].join(", ")}.`);
  return s;
}
/** Postgres unique violation → a friendly 409. */
function rethrowDuplicate(err: unknown, name: string): never {
  if ((err as { code?: string })?.code === "23505" || (err as any)?.cause?.code === "23505") {
    throw ApiError.conflict(`A region named "${name}" already exists.`);
  }
  throw err;
}

export async function listRegions(): Promise<RegionView[]> {
  let rows = await pgdb.select().from(regions).orderBy(asc(regions.name));

  if (rows.length === 0) {
    // First use: seed the defaults (attributed to whoever opened the page).
    await pgdb.transaction(async (tx) => {
      const created = await tx
        .insert(regions)
        .values(DEFAULT_REGIONS.map((name) => ({ name })))
        .onConflictDoNothing()
        .returning();
      for (const r of created) {
        await audit.change({ action: "region.create", entityType: "region", entityId: r.id, after: r, metadata: { seeded: true } }, tx);
      }
    });
    rows = await pgdb.select().from(regions).orderBy(asc(regions.name));
  }

  // Counts in two grouped queries rather than loading every conclave and user.
  const [conclaveCounts, memberCounts] = await Promise.all([
    pgdb
      .select({ region: sql<string>`coalesce(${conclaves.region}, 'Global')`, n: sql<number>`count(*)::int` })
      .from(conclaves)
      .groupBy(sql`1`),
    pgdb
      .select({ region: sql<string>`coalesce(${users.region}, ${users.location}, 'Global')`, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(sql`1`),
  ]);
  const cc = new Map(conclaveCounts.map((r) => [r.region, r.n]));
  const mc = new Map(memberCounts.map((r) => [r.region, r.n]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    conclavesCount: cc.get(r.name) ?? 0,
    membersCount: mc.get(r.name) ?? 0,
  }));
}

export async function createRegion(input: { name?: unknown; status?: unknown }): Promise<{ id: string }> {
  const name = cleanName(input.name);
  const status = cleanStatus(input.status);
  try {
    return await pgdb.transaction(async (tx) => {
      const [row] = await tx.insert(regions).values({ name, status }).returning();
      await audit.change({ action: "region.create", entityType: "region", entityId: row.id, after: row }, tx);
      return { id: row.id };
    });
  } catch (err) {
    rethrowDuplicate(err, name);
  }
}

export async function updateRegion(id: string, input: { name?: unknown; status?: unknown }): Promise<void> {
  const patch: { name?: string; status?: string } = {};
  if (input.name !== undefined) patch.name = cleanName(input.name);
  if (input.status !== undefined) patch.status = cleanStatus(input.status);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nothing to update (send name and/or status).");
  try {
    await pgdb.transaction(async (tx) => {
      const [before] = await tx.select().from(regions).where(eq(regions.id, id)).for("update");
      if (!before) throw ApiError.notFound("Region not found.");
      const [after] = await tx.update(regions).set(patch).where(eq(regions.id, id)).returning();
      await audit.change({ action: "region.update", entityType: "region", entityId: id, before, after }, tx);
    });
  } catch (err) {
    rethrowDuplicate(err, patch.name ?? "");
  }
}

export async function deleteRegion(id: string): Promise<void> {
  await pgdb.transaction(async (tx) => {
    const [before] = await tx.delete(regions).where(eq(regions.id, id)).returning();
    if (!before) throw ApiError.notFound("Region not found.");
    await audit.change({ action: "region.delete", entityType: "region", entityId: id, before, after: null }, tx);
  });
}
