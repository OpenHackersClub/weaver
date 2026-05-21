import { test, expect, type Page } from "./_fixtures";

/**
 * Inline-formatting + selection acceptance tests.
 *
 * Ctrl+B/I/U are wired in the DOM bridge today; Ctrl+A select-all and
 * clear-formatting are TDD-red targets from `specs/lexical-parity.md` §3.
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

const firstBlockHtml = (page: Page): Promise<string> =>
  page
    .locator("[data-weaver-root] [data-block-id]")
    .first()
    .innerHTML();

test.describe("keyboard formatting on a selection", () => {
  test("Ctrl+B wraps the selection in bold", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    expect((await firstBlockHtml(page)).toLowerCase()).toMatch(
      /<(strong|b)\b/,
    );
  });

  test("Ctrl+I wraps the selection in italic", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+i");
    expect((await firstBlockHtml(page)).toLowerCase()).toMatch(/<(em|i)\b/);
  });

  test("Ctrl+U wraps the selection in underline", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+u");
    expect((await firstBlockHtml(page)).toLowerCase()).toMatch(/<u\b/);
  });

  test("Ctrl+B twice toggles bold back off", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    expect((await firstBlockHtml(page)).toLowerCase()).not.toMatch(
      /<(strong|b)\b/,
    );
  });
});

test.describe("select-all spans the whole document", () => {
  // TDD red — and a bigger lift than a keymap entry: `text.toggleMark` is
  // single-block by signature `(blockId, range, mark)`, and the DOM bridge's
  // `computeMarkRangeWithinBlock` rejects cross-block ranges. Turning this
  // green needs a multi-block formatting path, not just a Ctrl+A handler.
  test("Ctrl+A then Ctrl+B bolds text across multiple blocks", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    const blocks = page.locator("[data-weaver-root] [data-block-id]");
    for (let i = 0; i < (await blocks.count()); i++) {
      const html = (await blocks.nth(i).innerHTML()).toLowerCase();
      expect(html).toMatch(/<(strong|b)\b/);
    }
  });
});

test.describe("clear formatting", () => {
  test("a clear-formatting shortcut strips marks from the selection", async ({
    page,
  }) => {
    // TDD red — no clear-formatting command/keymap yet. Lexical binds this to
    // Ctrl+\ in its playground.
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+\\");
    expect((await firstBlockHtml(page)).toLowerCase()).not.toMatch(
      /<(strong|b|em|i|u)\b/,
    );
  });
});
