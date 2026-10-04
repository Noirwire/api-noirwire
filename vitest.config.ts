import { defineConfig } from "vitest/config";
import { decorators } from "./vitest.shared.js";

/** Unit tests: the framework-free logic and the session guard. No network beyond localhost. */
export default defineConfig({
  plugins: [decorators],
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
