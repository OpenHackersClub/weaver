import { defineConfig, devices } from "@playwright/test";

// Smoke config: targets an externally deployed URL via WEAVER_SMOKE_URL.
// Does NOT spin up a local server. Use:
//   WEAVER_SMOKE_URL=https://… pnpm exec playwright test --config playwright.smoke.config.ts
export default defineConfig({
  testDir: "./tests/acceptance",
  testMatch: ["_smoke.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
