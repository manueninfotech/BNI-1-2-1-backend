import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { pgdb, pool } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { runWithContext } from "../../observability/context.js";
import * as chapters from "../chapters.service.js";

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithContext(
    { requestId: `t-${Math.random().toString(36).slice(2)}`, source: "admin_panel", actor: { uid: "admin-1", role: "admin", email: "a@bni.com" }, changeCount: 0 },
    fn,
  );

beforeEach(async () => {
  await pgdb.execute(sql`TRUNCATE settings, users CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("chapters", () => {
  it("starts empty, so the app keeps a text field", async () => {
    expect(await chapters.listChapters()).toEqual([]);
  });

  it("tidies, sorts and treats spellings the engine merges as one chapter", async () => {
    const list = await asAdmin(() => chapters.setChapters([" bni  amaravati ", "BNI Amaravati Chapter", "Krishna", "", "krishna"]));
    expect(list).toEqual(["Bni amaravati", "Krishna"]);
    await expect(asAdmin(() => chapters.addChapter("KRISHNA chapter"))).rejects.toMatchObject({ status: 409 });
    expect(await asAdmin(() => chapters.removeChapter("krishna"))).toEqual(["Bni amaravati"]);
    expect(await asAdmin(() => chapters.setChapters([]))).toEqual([]);
  });

  it("suggests typed chapters not on the list, most used first", async () => {
    await pgdb.insert(users).values([
      { uid: "a", name: "A", chapter: "BNI Krishna" },
      { uid: "b", name: "B", chapter: "bni krishna" },
      { uid: "c", name: "C", chapter: "BNI Krishna" },
      { uid: "d", name: "D", chapter: "Amaravati" },
      { uid: "e", name: "E", chapter: "Guntur" },
    ]);
    await asAdmin(() => chapters.setChapters(["Guntur"]));
    expect(await chapters.chapterSuggestions()).toEqual([
      { name: "BNI Krishna", members: 3 },
      { name: "Amaravati", members: 1 },
    ]);
  });

  it("snaps a typed chapter to the listed spelling", async () => {
    await asAdmin(() => chapters.setChapters(["BNI Amaravathi"]));
    expect(await chapters.canonicalChapter("bni amaravathi chapter")).toBe("BNI Amaravathi");
    expect(await chapters.canonicalChapter("Tenali")).toBe("Tenali");
  });
});
