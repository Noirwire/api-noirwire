import { defineConfig } from "vitest/config";
import { decorators } from "./vitest.shared.js";

/**
 * Integration tests: the real HTTP stack, with a local server standing in
 * for every provider. Nothing here reaches the internet.
 */
export default defineConfig({
  plugins: [decorators],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
