import { test, expect, type Page } from "@playwright/test";

/**
 * @-mention acceptance — the Notion-style tagging flow from
 * `specs/mentions.md`: typing `@` opens the typeahead menu, the query
 * filters principals, Enter/click inserts a mention chip backed by a
 * `mention` mark in LoroDoc, and the `MentionCreated` editor event reaches
 * app listeners debounced (asserted via the playground's mention log
 * mirror on `window.__weaver_mention_batches`).
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator('[data-weaver-root]');
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
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

test.describe("@-mention typeahead", () => {
  test("typing @ opens the menu; query filters; Escape dismisses", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    await page.keyboard.type("hello @");
    const menu = page.locator("[data-mention-menu]");
    await expect(menu).toBeVisible();
    // Unfiltered: all six demo principals.
    await expect(menu.locator('[role="option"]')).toHaveCount(6);

    await page.keyboard.type("ada");
    await expect(menu.locator('[role="option"]')).toHaveCount(1);
    await expect(menu.locator('[role="option"]').first()).toContainText(
      "Ada Lovelace",
    );

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("Enter inserts a mention chip backed by a mention mark", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    await page.keyboard.type("ping @ada");
    await expect(page.locator("[data-mention-menu]")).toBeVisible();
    await page.keyboard.press("Enter");

    const chip = page.locator(".weaver-mention");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText("@Ada Lovelace");
    await expect(chip).toHaveAttribute("data-mention-user-id", "user:ada");
    await expect(chip).toHaveAttribute("data-mention-kind", "user");
    await expect(page.locator("[data-mention-menu]")).toHaveCount(0);

    // The trigger text was replaced, a trailing space added, and the caret
    // sits after it — continued typing stays outside the chip.
    await page.keyboard.type("ok");
    await expect(
      page.locator('[data-weaver-root] [data-block-id]').first(),
    ).toHaveText("ping @Ada Lovelace ok");
    await expect(chip).toHaveText("@Ada Lovelace");
    // Note: the chip's data attributes are themselves the LoroDoc assertion —
    // the renderer builds them from the text delta's mention mark, and
    // `doc.toJSON()` flattens LoroText to a plain string (no mark attrs).
  });

  test("arrow keys navigate; click on an agent inserts an agent mention", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    await page.keyboard.type("@agent");
    const options = page.locator('[data-mention-menu] [role="option"]');
    await expect(options).toHaveCount(3);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");

    await options.nth(2).click();
    const chip = page.locator(".weaver-mention");
    await expect(chip).toHaveAttribute("data-mention-user-id", "agent-3");
    await expect(chip).toHaveAttribute("data-mention-kind", "agent");
  });

  test("MentionCreated reaches listeners debounced — a quick burst is one batch", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    // Two mentions inserted programmatically within the 500ms window. The
    // playground's listener subscribes with debounceMs: 500 and mirrors each
    // delivered batch to window.__weaver_mention_batches.
    await page.evaluate(() => {
      const dbg = (
        window as unknown as {
          __weaver_debug: { tree: () => Array<{ id: string }> };
          __weaver_editor?: unknown;
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
      w.__weaver_mention_insert(blockId, 0, "user:grace", "Grace Hopper");
    });

    // Inside the debounce window nothing has been delivered yet.
    expect(await mentionBatches(page)).toHaveLength(0);

    await expect
      .poll(async () => (await mentionBatches(page)).length, { timeout: 3000 })
      .toBe(1);
    const batches = await mentionBatches(page);
    expect(batches[0]!.map((e) => e.principalId)).toEqual([
      "user:ada",
      "user:grace",
    ]);
  });
});
