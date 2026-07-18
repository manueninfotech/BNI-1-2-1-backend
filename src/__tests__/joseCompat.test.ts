import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * Guards the `jose` override in package.json.
 *
 * The problem it exists for: jwks-rsa (CommonJS, pulled in by firebase-admin)
 * does `require('jose')`, but jose v6 is ESM-only. Node 22.12+ permits
 * require(ESM), so this works fine locally and in CI — and Vercel's serverless
 * runtime uses its OWN module loader, which does not. Every cold start died with
 * ERR_REQUIRE_ESM and a 500, which is about the worst place to find out.
 *
 * The override pins jose to v4, which ships a real CJS build. That is safe only
 * while the things below hold, so they are asserted rather than trusted: a
 * dependency bump that undoes any of them fails here instead of in production.
 */
describe("jose / jwks-rsa CommonJS compatibility", () => {
  const require = createRequire(import.meta.url);

  /**
   * Resolve from jwks-rsa's own location, not ours.
   *
   * jose is not a direct dependency of this package — npm nests it under
   * jwks-rsa — so `require('jose')` from here fails with "Cannot find module"
   * regardless of whether the override worked. jwks-rsa's perspective is the
   * only one that matters.
   */
  const requireFromJwksRsa = createRequire(require.resolve("jwks-rsa"));

  it("loads jwks-rsa — the exact import that crashed every cold start", () => {
    expect(() => require("jwks-rsa")).not.toThrow();
  });

  it("resolves a jose with a CommonJS build", () => {
    const pkgPath = requireFromJwksRsa.resolve("jose/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    // The point of the override: an ESM-only jose has no `require` entry, and
    // Vercel's loader cannot require it.
    expect(pkg.exports?.["."]?.require).toBeTruthy();
    expect(pkg.version).toMatch(/^4\./);
  });

  it("jose is require()-able from jwks-rsa", () => {
    expect(() => requireFromJwksRsa("jose")).not.toThrow();
  });

  it("still exports the functions jwks-rsa calls", () => {
    const jose = requireFromJwksRsa("jose");
    // The complete set used by jwks-rsa/src/utils.js. If v4 ever drops one, the
    // override is no longer safe and this says so.
    expect(typeof jose.importJWK).toBe("function");
    expect(typeof jose.exportSPKI).toBe("function");
  });

  it("firebase-admin auth loads, which is the path that was crashing", async () => {
    const { getAuth } = await import("firebase-admin/auth");
    expect(typeof getAuth).toBe("function");
  });
});
