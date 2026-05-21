import { defineConfig, devices } from "@playwright/test";

// Playwright config used by the flare-dispatch `cdp-acceptance` run.
//
// The run boots the SPA in a sibling container (`vite preview --host 0.0.0.0
// --port 5181 --strictPort`) and exposes a Cloudflare Browser Rendering CDP
// endpoint via `CDP_WS_URL`. The shared `_fixtures.ts` browser fixture picks
// that up and connects over CDP instead of launching a local Chromium, so
// the spec files are identical to the local-mode config.
//
// Artifacts: report goes to `playwright-report/` and traces/screenshots to
// `artifacts/` so the run can promote them to signed R2 URLs (see
// recipes/cdp-acceptance in OpenHackersClub/flare-dispatch).

const APP_PORT = Number(process.env["WEAVER_PG_PORT"] ?? 5181);
const BASE_URL = process.env["APP_URL"] ?? `http://localhost:${APP_PORT}`;

export default defineConfig({
  testDir: "./tests/acceptance",
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  outputDir: "artifacts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
