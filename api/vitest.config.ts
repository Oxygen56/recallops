import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    sequence: { concurrent: false },
    testTimeout: process.env.REQUIRE_DATABASE === "1" ? 60_000 : 20_000,
    hookTimeout: process.env.REQUIRE_DATABASE === "1" ? 60_000 : 20_000,
  },
});
