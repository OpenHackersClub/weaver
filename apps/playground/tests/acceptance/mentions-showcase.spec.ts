import { test, expect, type Page } from "@playwright/test";

/**
 * "Tag someone" showcase — the playground example demonstrating that tagging
 * a principal fires `MentionCreated` events, consumed two ways at once:
 *
 * - `MentionNotifications` subscribes WITHOUT debounce → each tag pops its
 *   own toast synchronously (per-event delivery);
 * - `MentionsLog` subscribes with `debounceMs: 500` → a burst of tags lands
 *   in the sidebar as ONE batch (trailing-debounce delivery).
 */

const SHOWCASE_URL = "/?example=mentions";

const focusLastBlock = async (page: Page) => {
  const blocks = page.locator("[data-weaver-root] [data-block-id]");
  await blocks.last().waitFor({ state: "visible" });
  await blocks.last().click();
  await page.keyboard.press("End");
};

const mentionBatches = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __weaver_mention_batches?: Array<
            Array<{ principalId: string; label: string; origin: string }>
          >;
        }
      ).__weaver_mention_batches ?? [],
  );

test.describe("Tag someone showcase", () => {
  test("the example seeds the showcase doc", async ({ page }) => {
    await page.goto(SHOWCASE_URL);
    await expect(
      page.locator("[data-weaver-root] [data-block-id]").first(),
    ).toHaveText("Tag someone — events demo");
    await expect(
      page.locator('.example-list button[data-active="true"]'),
    ).toHaveText("Tag someone");
  });

  test("tagging via the typeahead pops a notification toast and logs the event", async ({
    page,
  }) => {
    await page.goto(SHOWCASE_URL);
    await focusLastBlock(page);

    await page.keyboard.type("@grace");
    await expect(page.locator("[data-mention-menu]")).toBeVisible();
    await page.keyboard.press("Enter");

    // The chip landed…
    const chip = page.locator(".weaver-mention");
    await expect(chip).toHaveAttribute("data-mention-user-id", "user:grace");

    // …and the undebounced subscriber reacted instantly with a toast.
    const toast = page.locator("[data-mention-notification]");
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("@Grace Hopper was notified");
    await expect(toast).toContainText("tagged by user");
    await expect(toast).toHaveAttribute("data-principal-id", "user:grace");

    // The debounced sidebar log receives the same event ~500 ms later.
    const logEntry = page.locator("[data-mentions-log] [data-mention-event]");
    await expect(logEntry).toHaveCount(1);
    await expect(logEntry).toHaveAttribute("data-principal-id", "user:grace");
  });

  test("a burst of tags pops one toast per event while the log batches", async ({
    page,
  }) => {
    await page.goto(SHOWCASE_URL);
    await page.locator("[data-weaver-root]").waitFor({ state: "visible" });

    await page.evaluate(() => {
      const dbg = (
        window as unknown as {
          __weaver_debug: { tree: () => Array<{ id: string }> };
        }
      ).__weaver_debug;
      const blockId = dbg.tree()[0]!.id;
      const w = window as unknown as {
        __weaver_mention_insert?: (
          blockId: string,
          at: number,
          id: string,
          label: string,
        ) => void;
      };
      if (!w.__weaver_mention_insert) {
        throw new Error("debug insert hook missing");
      }
      w.__weaver_mention_insert(blockId, 0, "user:ada", "Ada Lovelace");
      w.__weaver_mention_insert(blockId, 0, "agent-1", "Agent 1");
    });

    // Per-event delivery: two separate toasts, kinds preserved.
    const toasts = page.locator("[data-mention-notification]");
    await expect(toasts).toHaveCount(2);
    await expect(toasts.nth(0)).toHaveAttribute("data-principal-id", "user:ada");
    await expect(toasts.nth(1)).toHaveAttribute("data-principal-id", "agent-1");
    await expect(toasts.nth(1)).toContainText("agent · tagged by user");

    // Debounced delivery: the same burst reaches the log as ONE batch.
    await expect
      .poll(async () => (await mentionBatches(page)).length, { timeout: 3000 })
      .toBe(1);
    const batches = await mentionBatches(page);
    expect(batches[0]!.map((e) => e.principalId)).toEqual([
      "user:ada",
      "agent-1",
    ]);
  });
});
