import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { pgdb, pool } from "../../db/client.js";
import { conclaves } from "../../db/schema.js";
import { publicConclave } from "../publicConclave.service.js";

beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE conclaves CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("public conclave preview", () => {
  it("shows only name, place, dates and status", async () => {
    await pgdb.insert(conclaves).values({ id: "conc-123456", name: "Guntur Mega 1-2-1", venueLocation: "Hotel Grand, Guntur", region: "Guntur", startDate: new Date("2026-12-12T04:30:00Z"), startTime: "10:00 AM" } as any);
    const p = await publicConclave("conc-123456");
    expect(p).toMatchObject({ id: "conc-123456", name: "Guntur Mega 1-2-1", venue: "Hotel Grand, Guntur", region: "Guntur", startTime: "10:00 AM" });
    expect(Object.keys(p).sort()).toEqual(["endDate", "endTime", "id", "name", "region", "startDate", "startTime", "status", "venue"]);
  });

  it("404s unknown or malformed ids", async () => {
    await expect(publicConclave("nope-000000")).rejects.toMatchObject({ status: 404 });
    await expect(publicConclave("../../etc")).rejects.toMatchObject({ status: 404 });
  });
});
