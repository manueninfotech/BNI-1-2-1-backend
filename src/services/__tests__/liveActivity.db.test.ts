import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// FCM is faked (records each sendEach batch); data is real Postgres.
const batches: Array<Array<Record<string, any>>> = [];
let failToken: string | null = null;
vi.mock("../../config/firebase.js", () => ({
  db: { collection: () => ({ doc: (id: string) => ({ id }) }) },
  collections: { conclaves: "conclaves" },
  auth: {},
  messaging: {
    send: async () => "ok",
    sendEach: async (msgs: Array<Record<string, any>>) => {
      batches.push(msgs);
      return {
        successCount: msgs.filter((m) => m.apns.liveActivityToken !== failToken).length,
        failureCount: 0,
        responses: msgs.map((m) =>
          m.apns.liveActivityToken === failToken
            ? { success: false, error: { code: "messaging/registration-token-not-registered" } }
            : { success: true },
        ),
      };
    },
  },
}));

const { pgdb, pool } = await import("../../db/client.js");
const { conclaves, registrations, users, liveActivityTokens } = await import("../../db/schema.js");
const la = await import("../liveActivity.service.js");

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 20, 4, 0, 0);
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

async function seed() {
  await pgdb.insert(users).values([
    { uid: "u1", name: "Asha", category: "A" },
    { uid: "u2", name: "Ravi", category: "B" },
  ] as any);
  const [c] = await pgdb
    .insert(conclaves)
    .values({
      name: "Live",
      venueLocation: "Hall",
      status: "running",
      personsPerTable: 5,
      roundCount: 2,
      currentRound: 1,
      currentRoundStartedAt: new Date(T0),
      roundProgressionMode: "automatic",
      moveSeconds: 120,
      schedule: {
        rounds: [
          { roundNumber: 1, tables: [{ tableNumber: 1, captainId: 1, memberIds: [2] }] },
          { roundNumber: 2, tables: [{ tableNumber: 1, captainId: 1, memberIds: [2] }] },
        ],
      },
      participants: [
        { id: 1, _originalUid: "u1" },
        { id: 2, _originalUid: "u2" },
      ],
    } as any)
    .returning();
  await pgdb.insert(registrations).values([
    { conclaveId: c.id, userId: "u1", role: "captain" },
    { conclaveId: c.id, userId: "u2", role: "member" },
  ] as any);
  return c.id as string;
}

beforeEach(async () => {
  batches.length = 0;
  failToken = null;
  await pgdb.execute(sql`TRUNCATE conclaves, users CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("Live Activity pushes", () => {
  it("rejects people who aren't registered and malformed tokens", async () => {
    const id = await seed();
    await expect(la.registerToken(id, "stranger", { pushToken: TOKEN_A, fcmToken: "f" })).rejects.toMatchObject({ status: 403 });
    await expect(la.registerToken(id, "u2", { pushToken: "nope", fcmToken: "f" })).rejects.toMatchObject({ status: 400 });
  });

  it("pushes once per change, with each member's own card", async () => {
    const id = await seed();
    await la.registerToken(id, "u1", { pushToken: TOKEN_A, fcmToken: "fcm-1" });
    await la.registerToken(id, "u2", { pushToken: TOKEN_B, fcmToken: "fcm-2" });

    expect(await la.sweepLiveActivities(T0 + 1 * MIN)).toBe(2);
    const first = batches.at(-1)!;
    const byToken = Object.fromEntries(first.map((m) => [m.apns.liveActivityToken, m]));
    expect(byToken[TOKEN_B].token).toBe("fcm-2");
    expect(byToken[TOKEN_B].apns.payload.aps).toMatchObject({
      event: "update",
      "content-state": { round: 1, tableNumber: 1, line: "Introductions · 1 min each", paused: false },
    });

    // Same phase a minute later: nothing sent.
    expect(await la.sweepLiveActivities(T0 + 2 * MIN)).toBe(0);

    // Move break: member told where to go, captain to stay.
    await la.sweepLiveActivities(T0 + 8 * MIN);
    const move = Object.fromEntries(batches.at(-1)!.map((m) => [m.apns.liveActivityToken, m.apns.payload.aps["content-state"].line]));
    expect(move[TOKEN_B]).toBe("Move to Table 1");
    expect(move[TOKEN_A]).toBe("Stay at Table 1 · your next group is arriving");
  });

  it("drops dead tokens, and ends + forgets every card when the conclave completes", async () => {
    const id = await seed();
    await la.registerToken(id, "u1", { pushToken: TOKEN_A, fcmToken: "fcm-1" });
    await la.registerToken(id, "u2", { pushToken: TOKEN_B, fcmToken: "fcm-2" });
    failToken = TOKEN_A;
    await la.sweepLiveActivities(T0 + 1 * MIN);
    let left = await pgdb.select().from(liveActivityTokens).where(eq(liveActivityTokens.conclaveId, id));
    expect(left.map((t) => t.userId)).toEqual(["u2"]);

    failToken = null;
    await pgdb.update(conclaves).set({ status: "completed" }).where(eq(conclaves.id, id));
    await la.sweepLiveActivities(T0 + 30 * MIN);
    expect(batches.at(-1)![0].apns.payload.aps.event).toBe("end");
    left = await pgdb.select().from(liveActivityTokens).where(eq(liveActivityTokens.conclaveId, id));
    expect(left).toHaveLength(0);
  });
});
