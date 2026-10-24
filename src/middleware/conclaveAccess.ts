import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves } from "../db/schema.js";
import { ApiError } from "./errors.js";
import type { AuthedRequest } from "./auth.js";
import type { AdminRecord } from "../services/admins.service.js";
import { normRegion } from "../services/conclave.service.js";

/**
 * Regional authorization for the admin panel.
 *
 * A superadmin, or any admin whose region is "Global", sees every conclave.
 * Everyone else (coordinators, regional admins) sees only conclaves in their
 * own region. Derived from the stored admin record — never from an email.
 */

/** null = every region; otherwise the one region this admin is scoped to. */
export function regionScope(admin: AdminRecord | undefined): string | null {
  if (!admin) return "__none__";
  if (admin.role === "superadmin" || normRegion(admin.region) === "global") return null;
  return admin.region ?? "__none__";
}

export function assertRegion(admin: AdminRecord | undefined, conclaveRegion: string | null | undefined) {
  const scope = regionScope(admin);
  if (scope === null) return;
  if (scope === "__none__") throw ApiError.forbidden("You must be assigned to a region to manage conclaves.");
  if (normRegion(conclaveRegion) !== normRegion(scope)) {
    throw ApiError.forbidden(`You can only manage conclaves in your assigned region: "${scope}".`);
  }
}

/**
 * Guard for every /conclaves/:id/... admin route: the conclave must be in the
 * caller's region. Mounted once on the router, so a new nested route can't be
 * added without it.
 */
export async function requireConclaveAccess(req: Request, _res: Response, next: NextFunction) {
  const admin = (req as AuthedRequest).admin;
  if (regionScope(admin) === null) return next();
  const id = (req.params as Record<string, string>).id;
  const [row] = await pgdb.select({ region: conclaves.region }).from(conclaves).where(eq(conclaves.id, id));
  if (!row) throw ApiError.notFound("Conclave not found.");
  assertRegion(admin, row.region);
  next();
}
