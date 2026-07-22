import { db, collections } from "../config/firebase.js";
import { ApiError } from "../middleware/errors.js";
import {
  ConclaveStatus,
  ROUND_LIMITS,
  MIN_PERSONS_PER_TABLE,
  TERMINAL_STATUSES,
} from "../domain/conclave.js";
import { toDate } from "../utils/firestore.js";
import { notifyConclave } from "./notification.service.js";

export const conclaveRef = (id: string) =>
  db.collection(collections.conclaves).doc(id);

export async function getConclaveOrThrow(id: string) {
  const doc = await conclaveRef(id).get();
  if (!doc.exists) throw ApiError.notFound("Conclave not found.");
  return { ref: conclaveRef(id), data: doc.data()!, doc };
}

interface CreateInput {
  name?: string;
  venueLocation?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  chiefGuests?: unknown;
  personsPerTable?: number;
  roundCount?: number;
  region?: string;
}

/**
 * Validates the knobs the engine depends on.
 *
 * These were previously only checked at schedule-generation time, which meant an
 * admin could create a conclave with 99 rounds and only discover it was invalid
 * after registration had closed. Fail at creation instead.
 */
export function validateConfig(personsPerTable: number, roundCount: number) {
  if (!Number.isInteger(personsPerTable) || personsPerTable < MIN_PERSONS_PER_TABLE) {
    throw ApiError.badRequest(
      `personsPerTable must be a whole number of at least ${MIN_PERSONS_PER_TABLE}.`,
    );
  }
  if (
    !Number.isInteger(roundCount) ||
    roundCount < ROUND_LIMITS.min ||
    roundCount > ROUND_LIMITS.max
  ) {
    throw ApiError.badRequest(
      `roundCount must be between ${ROUND_LIMITS.min} and ${ROUND_LIMITS.max}.`,
    );
  }
}

export async function createConclave(input: CreateInput) {
  if (!input.name || !input.venueLocation) {
    throw ApiError.badRequest("name and venueLocation are required.");
  }

  const personsPerTable = input.personsPerTable ?? 7;
  const roundCount = input.roundCount ?? 6;
  validateConfig(personsPerTable, roundCount);

  const ref = await db.collection(collections.conclaves).add({
    name: input.name,
    venueLocation: input.venueLocation,
    region: input.region || "Guntur Region",
    date: input.date ? new Date(input.date) : new Date(),
    // Start/end are flexible: either may be absent.
    startTime: input.startTime ? new Date(input.startTime) : null,
    endTime: input.endTime ? new Date(input.endTime) : null,
    chiefGuests: Array.isArray(input.chiefGuests) ? input.chiefGuests : [],

    // A new conclave is NOT accepting registrations. The admin opens the doors
    // deliberately rather than the system opening them by default.
    status: ConclaveStatus.registrationNotOpen,
    isRegistrationOpen: false,

    personsPerTable,
    roundCount,
    currentRound: 0,
    schedule: null,
    participants: null,
    createdAt: new Date(),
  });

  return ref.id;
}

export async function updateConclave(id: string, body: Record<string, unknown>) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.running || status === ConclaveStatus.completed) {
    throw ApiError.conflict(`Cannot edit a conclave that is ${status}.`);
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.venueLocation !== undefined) updates.venueLocation = body.venueLocation;
  if (body.region !== undefined) updates.region = body.region;
  if (body.date !== undefined) updates.date = body.date ? new Date(body.date as string) : null;
  if (body.startTime !== undefined) {
    updates.startTime = body.startTime ? new Date(body.startTime as string) : null;
  }
  if (body.endTime !== undefined) {
    updates.endTime = body.endTime ? new Date(body.endTime as string) : null;
  }
  if (body.chiefGuests !== undefined) {
    updates.chiefGuests = Array.isArray(body.chiefGuests) ? body.chiefGuests : [];
  }

  // Table size and round count are baked into a generated schedule. Changing
  // them afterwards would leave the schedule describing a different event.
  if (body.personsPerTable !== undefined || body.roundCount !== undefined) {
    if (data.schedule) {
      throw ApiError.conflict(
        "A schedule already exists. Changing persons-per-table or round count would invalidate it — regenerate the schedule instead.",
      );
    }
    const p = (body.personsPerTable as number) ?? data.personsPerTable;
    const r = (body.roundCount as number) ?? data.roundCount;
    validateConfig(p, r);
    updates.personsPerTable = p;
    updates.roundCount = r;
  }

  if (Object.keys(updates).length === 0) {
    throw ApiError.badRequest("Nothing to update.");
  }

  updates.updatedAt = new Date();
  await ref.update(updates);
  return Object.keys(updates);
}

/** Open or close registration. Two-way, unlike a one-shot "close". */
export async function setRegistrationOpen(id: string, open: boolean) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (TERMINAL_STATUSES.has(status) || status === ConclaveStatus.running) {
    throw ApiError.conflict(
      `Cannot change registration on a conclave that is ${status}.`,
    );
  }

  await ref.update({
    isRegistrationOpen: open,
    status: open ? ConclaveStatus.registrationOpen : ConclaveStatus.registrationClosed,
  });
}

/**
 * Call a conclave off before it starts.
 *
 * Cancel means "this event is not happening". Once it IS happening, that is no
 * longer true — people are sitting at tables, attendance and referrals have been
 * recorded, and those records deserve a summary rather than a tombstone. Ending
 * a live event early is what `complete` is for; it keeps everything and lets
 * members see what they did.
 *
 * So this is deliberately blocked while running, and the error says which door
 * to use instead.
 */
export async function cancelConclave(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.completed) {
    throw ApiError.conflict("A completed conclave cannot be cancelled.");
  }

  if (status === ConclaveStatus.running) {
    throw ApiError.conflict(
      "This conclave is running — it cannot be cancelled. Use End Conclave to " +
        "stop it now; members keep their attendance and referrals, and get their " +
        "summaries.",
    );
  }

  if (status === ConclaveStatus.cancelled) {
    throw ApiError.conflict("This conclave is already cancelled.");
  }

  await ref.update({
    status: ConclaveStatus.cancelled,
    isRegistrationOpen: false,
    cancelledAt: new Date(),
  });
}

/**
 * End the conclave.
 *
 * This is the transition the members' post-conclave summary depends on: until a
 * conclave is `completed`, nobody can see what they recorded or whether it
 * synced. It also nudges everyone to check their data made it off their phone —
 * the last moment they are all still in the room.
 */
export async function completeConclave(id: string) {
  const { ref, data } = await getConclaveOrThrow(id);
  const status = data.status ?? "";

  if (status === ConclaveStatus.completed) {
    throw ApiError.conflict("This conclave is already completed.");
  }
  if (status !== ConclaveStatus.running) {
    throw ApiError.conflict(
      `Only a running conclave can be completed (this one is ${status}).`,
    );
  }

  await ref.update({
    status: ConclaveStatus.completed,
    isRegistrationOpen: false,
    completedAt: new Date(),
  });

  await notifyConclave(id, {
    title: "The conclave has ended",
    body: "Open the app to see your summary, your referrals, and whether your data has synced.",
    data: { conclaveId: id, type: "conclave_completed" },
  });

  const finalRound = data.currentRound ?? 0;
  const roundCount = data.roundCount ?? 0;
  return { finalRound, roundCount, endedEarly: finalRound < roundCount };
}

/**
 * Start a round.
 *
 * One admin cannot run two conclaves at once: rounds are advanced by hand, by a
 * person standing in the room. They cannot be in two rooms, and a conclave whose
 * rounds nobody advances just stalls with everyone sitting at a table. A
 * DIFFERENT admin running a different conclave is fine — this constrains the
 * human, not the system.
 */
export async function startRound(id: string, roundNumber: number, adminUid: string) {
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw ApiError.badRequest("roundNumber must be a positive whole number.");
  }

  const { ref, data } = await getConclaveOrThrow(id);

  if (roundNumber > (data.roundCount ?? 0)) {
    throw ApiError.badRequest(
      `This conclave has only ${data.roundCount} rounds.`,
    );
  }

  if (roundNumber === 1) {
    if (!data.schedule) {
      throw ApiError.badRequest(
        "No schedule has been generated. Generate one before starting round 1.",
      );
    }

    const running = await db
      .collection(collections.conclaves)
      .where("status", "==", ConclaveStatus.running)
      .where("startedBy", "==", adminUid)
      .get();

    const other = running.docs.find((d) => d.id !== id);
    if (other) {
      throw ApiError.conflict(
        `You are already running "${other.data().name}". End it before starting another — ` +
          `rounds are advanced by hand, and you cannot be in two rooms at once.`,
        { runningConclaveId: other.id },
      );
    }
  }

  const roundStartedAt = new Date();
  await ref.update({
    status: ConclaveStatus.running,
    isRegistrationOpen: false,
    currentRound: roundNumber,
    currentRoundStartedAt: roundStartedAt,
    ...(roundNumber === 1 ? { startedBy: adminUid } : {}),
  });

  // A nudge, never the mechanism: the app derives round state from the conclave
  // document, so a missed push costs a notification, not correctness.
  await notifyConclave(id, {
    title: `Round ${roundNumber} has started`,
    body: "Go to your table — open the app to see who you're sitting with.",
    data: { conclaveId: id, roundNumber: String(roundNumber), type: "round_started" },
  });

  return roundStartedAt;
}

export async function listConclaves(region?: string) {
  let query: FirebaseFirestore.Query = db
    .collection(collections.conclaves)
    .orderBy("date", "desc");

  // Scope to a specific region unless the caller is superadmin/Global.
  if (region) {
    query = query.where("region", "==", region);
  }

  const snap = await query.get();

  return Promise.all(
    snap.docs.map(async (doc) => {
      const count = await doc.ref.collection(collections.registrations).count().get();
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        date: toDate(d.date)?.toISOString() ?? null,
        startTime: toDate(d.startTime)?.toISOString() ?? null,
        endTime: toDate(d.endTime)?.toISOString() ?? null,
        registrationCount: count.data().count,
      };
    }),
  );
}
