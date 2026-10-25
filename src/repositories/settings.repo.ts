import { eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { settings } from "../db/schema.js";
import { audit } from "../audit/audit.service.js";

/**
 * Key → JSON settings documents (one per concern: roundTiming, regions,
 * businessCategories, notificationTemplates, conclaveDefaults, app).
 *
 * Every write records an audit "change" with the field-level diff, in the same
 * transaction as the write.
 */

/** Read a settings document; {} when absent or unreadable (callers apply defaults). */
export async function readSetting(key: string): Promise<Record<string, any>> {
  try {
    const [row] = await pgdb.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return (row?.value as Record<string, any>) ?? {};
  } catch (err) {
    // Unreachable settings must not take the API down; every getter has defaults.
    console.error(JSON.stringify({ level: "error", msg: "settings read failed", key, err: (err as Error).message }));
    return {};
  }
}

/** Merge `patch` into a settings document (creating it if needed), audited. */
export async function writeSetting(key: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return pgdb.transaction(async (tx) => {
    const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).for("update");
    const before = (row?.value as Record<string, unknown>) ?? null;
    const next = { ...(before ?? {}), ...patch };
    await tx
      .insert(settings)
      .values({ key, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    await audit.change({ action: "settings.update", entityType: "settings", entityId: key, before, after: next }, tx);
    return next;
  });
}
