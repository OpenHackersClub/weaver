import { test, expect } from "@playwright/test";

const LIVE = process.env["WEAVER_SMOKE_URL"];

test.skip(!LIVE, "smoke test requires WEAVER_SMOKE_URL");

test("deployed playground accepts typed input end-to-end", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${LIVE}/?example=empty`);
  await expect(page.locator('[data-weaver-root]')).toBeVisible();
  await expect(page.locator('[data-weaver-root] [data-block-id]')).toHaveCount(1);
  await page.locator('[data-weaver-root]').click();
  await page.keyboard.type("smoke test ok");
  await expect(page.locator('[data-weaver-root] [data-block-id]').first()).toHaveText(
    "smoke test ok",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("# new heading");
  // The '# ' is consumed by the markdown shortcut after typing the first space.
  await expect(page.locator('[data-weaver-root] [data-block-id]')).toHaveCount(2);
  await expect(
    page.locator('[data-weaver-root] [data-block-id][data-kind="heading"]').first(),
  ).toHaveText("new heading");
  expect(errors, errors.join("\n")).toEqual([]);
});
