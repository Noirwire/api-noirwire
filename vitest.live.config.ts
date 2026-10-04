import { defineConfig } from "vitest/config";

/**
 * The live suite: read-only calls through a running copy of this API to the
 * real providers. It runs only when API_LIVE_URL is set, and never in CI on
 * a push or a pull request.
 */
export default defineConfig({
  test: { include: ["tests/live/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
