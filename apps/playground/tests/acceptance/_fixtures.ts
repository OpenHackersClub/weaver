import { test as base, chromium, type Browser } from "@playwright/test";

// When CDP_WS_URL is set (e.g. inside the flare-dispatch `cdp-acceptance` run
// container, where the browser is provided by Cloudflare Browser Rendering),
// override the `browser` fixture to attach over CDP instead of launching a
// local Chromium. Locally and in non-CDP CI runs, CDP_WS_URL is unset and
// Playwright's default browser launcher is used.
const cdpWsUrl = process.env["CDP_WS_URL"];

export const test = cdpWsUrl
  ? base.extend<object, { browser: Browser }>({
      browser: [
        async (_unused, use) => {
          const browser = await chromium.connectOverCDP(cdpWsUrl);
          await use(browser);
          await browser.close();
        },
        { scope: "worker" },
      ],
    })
  : base;

export { expect, type Page } from "@playwright/test";
