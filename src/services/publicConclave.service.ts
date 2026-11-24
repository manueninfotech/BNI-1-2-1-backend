import { eq } from "drizzle-orm";
import { pgdb } from "../db/client.js";
import { conclaves } from "../db/schema.js";
import { ApiError } from "../middleware/errors.js";

/**
 * What a shared conclave link may show to anyone, signed in or not: the
 * conclave's name, place, dates and status. Nothing about who is registered,
 * fees or payment details. Backs the link preview page on manuen.com and the
 * app when it opens a link before sign-in.
 */
export interface PublicConclave {
  id: string;
  name: string;
  venue: string;
  region: string;
  startDate: string | null;
  endDate: string | null;
  startTime: string;
  endTime: string;
  status: string;
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export async function publicConclave(id: string): Promise<PublicConclave> {
  if (!ID.test(id)) throw ApiError.notFound("No such conclave.");
  const [c] = await pgdb
    .select({
      id: conclaves.id,
      name: conclaves.name,
      venue: conclaves.venueLocation,
      region: conclaves.region,
      startDate: conclaves.startDate,
      endDate: conclaves.endDate,
      startTime: conclaves.startTime,
      endTime: conclaves.endTime,
      status: conclaves.status,
    })
    .from(conclaves)
    .where(eq(conclaves.id, id));
  if (!c) throw ApiError.notFound("No such conclave.");
  return {
    id: c.id,
    name: c.name,
    venue: c.venue ?? "",
    region: c.region ?? "",
    startDate: c.startDate?.toISOString() ?? null,
    endDate: c.endDate?.toISOString() ?? null,
    startTime: c.startTime ?? "",
    endTime: c.endTime ?? "",
    status: c.status,
  };
}
