import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests run against a dedicated local database, never dev/prod.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/conclave_test",
      NODE_ENV: "test",
    },
    globalSetup: ["./src/test/globalSetup.ts"],
    // Database tests share one Postgres; run files one at a time so a TRUNCATE
    // in one file can't race another.
    fileParallelism: false,
  },
});
