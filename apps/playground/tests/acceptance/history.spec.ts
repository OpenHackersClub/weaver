import { test, expect, type Page } from "@playwright/test";

/**
 * Undo / redo acceptance tests — TDD red.
 *
 * Loro ships an `UndoManager`; weaver has not yet wired `Ctrl+Z` /
 * `Ctrl+Shift+Z` into the DOM bridge. `specs/lexical-parity.md` §3 commits
 * to UNDO_COMMAND / REDO_COMMAND. These mirror Lexical's `History.spec.mjs`.
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

const blockTexts = (page: Page): Promise<string[]> =>
  page.$$eval("[data-weaver-root] [data-block-id]", (nodes) =>
    nodes.map((n) => (n.textContent ?? "").replace(/ |​/g, "")),
  );

const undo = (page: Page) => page.keyboard.press("Control+z");
const redo = (page: Page) => page.keyboard.press("Control+Shift+z");

test.describe("undo", () => {
  test("Ctrl+Z reverts typed text", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await undo(page);
    expect((await blockTexts(page)).join("")).toBe("");
  });

  test("Ctrl+Z reverts an Enter split (block count drops back to 1)", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await expect(
      page.locator("[data-weaver-root] [data-block-id]"),
    ).toHaveCount(2);
    await undo(page); // undo "second"
    await undo(page); // undo the split
    await expect(
      page.locator("[data-weaver-root] [data-block-id]"),
    ).toHaveCount(1);
  });

  test("Ctrl+Z reverts a markdown heading transform", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("# ");
    await expect(
      page.locator("[data-weaver-root] [data-block-id]").first(),
    ).toHaveAttribute("data-kind", "heading");
    await undo(page);
    await expect(
      page.locator("[data-weaver-root] [data-block-id]").first(),
    ).toHaveAttribute("data-kind", "paragraph");
  });
});

test.describe("redo", () => {
  test("Ctrl+Shift+Z re-applies an undone insert", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await undo(page);
    // Intermediate: undo must genuinely empty the doc. Without this the test
    // would pass vacuously (no-op undo + no-op redo both leave "hello").
    expect((await blockTexts(page)).join("")).toBe("");
    await redo(page);
    expect((await blockTexts(page)).join("")).toBe("hello");
  });

  test("a fresh edit after undo clears the redo path", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("alpha");
    await undo(page);
    // Confirm undo actually removed "alpha" before continuing — otherwise a
    // buggy undo would leave "alphabeta" and fail for the wrong reason.
    expect((await blockTexts(page)).join("")).toBe("");
    await page.keyboard.type("beta");
    await redo(page); // redo stack was invalidated by the new edit
    expect((await blockTexts(page)).join("")).toBe("beta");
  });
});
