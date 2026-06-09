import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // The relay tests live in @weaver/sync-core; the DO can't run under Node
    // vitest (it imports `cloudflare:workers`). Keep `test` a no-op success so
    // `pnpm -r test` doesn't fail on an empty suite.
    passWithNoTests: true,
  },
});
