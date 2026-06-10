import { test, expect, type Page } from "@playwright/test";

/**
 * Block-boundary regression guards, added by the 2026-06 acceptance-test
 * audit. Every test here pins a bug that shipped to the deployed playground:
 *
 *   1. Indenting a block removed its element from the DOM — the reconciler
 *      only rendered root-level children, despite a commit claiming the
 *      recursive fix. (The old indent tests only asserted the Loro tree,
 *      which is exactly why the regression was invisible.)
 *   2. Typing after a `--- ` divider transform threw an uncaught
 *      "has no inline text" error per keystroke and swallowed the input.
 *   3. Enter at the end of a heading/quote produced another heading/quote
 *      instead of a paragraph (Lexical/Notion parity).
 *   4. The to-do checkbox affordance was rendered but did nothing on click.
 *   5. Merging a block whose children were nested (via Tab) deleted the
 *      children from the LoroDoc — silent data loss.
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

const blockKinds = (page: Page): Promise<string[]> =>
  page.$$eval("[data-weaver-root] [data-block-id]", (nodes) =>
    nodes.map((n) => n.getAttribute("data-kind") ?? ""),
  );

const blockTexts = (page: Page): Promise<string[]> =>
  page.$$eval("[data-weaver-root] [data-block-id]", (nodes) =>
    nodes.map((n) => (n.textContent ?? "").replace(/​/g, "")),
  );

const blockDepths = (page: Page): Promise<string[]> =>
  page.$$eval("[data-weaver-root] [data-block-id]", (nodes) =>
    nodes.map((n) => n.getAttribute("data-depth") ?? ""),
  );

test.describe("nested blocks stay rendered", () => {
  test("Tab-indenting a list item keeps it visible in the DOM at depth 1", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    await page.keyboard.press("Tab");
    // The indented block must NOT disappear from the rendered document.
    expect(await blockTexts(page)).toEqual(["alpha", "beta"]);
    expect(await blockDepths(page)).toEqual(["0", "1"]);
    // And the indent must be visually material (margin), not just an attr.
    const margin = await page
      .locator('[data-weaver-root] [data-block-id]')
      .nth(1)
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).marginLeft));
    expect(margin).toBeGreaterThan(0);
  });

  test("Shift+Tab restores depth 0 in both tree and DOM", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await blockTexts(page)).toEqual(["alpha", "beta"]);
    expect(await blockDepths(page)).toEqual(["0", "0"]);
  });

  test("typing continues to work in a block that was just indented", async ({
    page,
  }) => {
    // The caret used to be lost when the indented element left the DOM.
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    await page.keyboard.press("Tab");
    await page.keyboard.type("!");
    expect(await blockTexts(page)).toEqual(["alpha", "beta!"]);
  });
});

test.describe("divider lifecycle", () => {
  test("'--- ' yields divider + paragraph; typing flows into the paragraph with no errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("--- ");
    expect(await blockKinds(page)).toEqual(["divider", "paragraph"]);
    await page.keyboard.type("hello");
    expect(await blockTexts(page)).toEqual(["", "hello"]);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("Backspace just after creating a divider removes the divider", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("--- ");
    await page.keyboard.press("Backspace");
    expect(await blockKinds(page)).toEqual(["paragraph"]);
  });
});

test.describe("Enter exits heading and quote", () => {
  test("Enter at end of a heading starts a paragraph", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("# Title");
    await page.keyboard.press("Enter");
    await page.keyboard.type("body");
    expect(await blockKinds(page)).toEqual(["heading", "paragraph"]);
    expect(await blockTexts(page)).toEqual(["Title", "body"]);
  });

  test("Enter at end of a quote starts a paragraph", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("> quoted");
    await page.keyboard.press("Enter");
    expect(await blockKinds(page)).toEqual(["quote", "paragraph"]);
  });

  test("Enter in the middle of a heading keeps the tail a heading", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("# alphabet");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    expect(await blockKinds(page)).toEqual(["heading", "heading"]);
    expect(await blockTexts(page)).toEqual(["alpha", "bet"]);
  });
});

test.describe("to-do checkbox interaction", () => {
  test("clicking the checkbox toggles checked state, persisted in the LoroDoc", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("[ ] task");
    const check = page.locator("[data-todo-check]").first();
    await expect(check).toBeVisible();
    await expect(check).toHaveAttribute("aria-checked", "false");

    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    const snapshot = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { __weaver_debug?: { snapshot: () => unknown } })
          .__weaver_debug?.snapshot(),
      ),
    );
    expect(snapshot).toContain('"checked":true');

    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "false");
  });

  test("toggling the checkbox does not delete the task text", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("[ ] task");
    await page.locator("[data-todo-check]").first().click();
    expect(await blockTexts(page)).toEqual(["task"]);
  });
});

test.describe("merge preserves nested children", () => {
  test("Backspace-merging a parent block does not delete its nested children", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Enter");
    await page.keyboard.type("third");
    await page.keyboard.press("Tab"); // nest "third" under "second"

    // Merge "second" into "first" via Backspace at its start.
    await page.locator('[data-weaver-root] [data-block-id]').nth(1).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");

    expect(await blockTexts(page)).toEqual(["firstsecond", "third"]);
    const snapshot = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { __weaver_debug?: { snapshot: () => unknown } })
          .__weaver_debug?.snapshot(),
      ),
    );
    expect(snapshot).toContain("third");
  });

  test("Backspace at the start of a nested block outdents it first", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    await page.keyboard.press("Tab");
    expect(await blockDepths(page)).toEqual(["0", "1"]);
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    expect(await blockDepths(page)).toEqual(["0", "0"]);
    expect(await blockKinds(page)).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
  });
});

test.describe("Tab inside a code block", () => {
  test("inserts a literal tab character instead of indenting the block", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("``` ");
    expect(await blockKinds(page)).toEqual(["code"]);
    await page.keyboard.type("if x:");
    await page.keyboard.press("Tab");
    await page.keyboard.type("y");
    expect(await blockTexts(page)).toEqual(["if x:\ty"]);
  });
});

test.describe("Enter inside a code block (PR #34 follow-up)", () => {
  test("Enter is a soft newline — multi-line code stays one block", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("``` ");
    await page.keyboard.type("line1");
    await page.keyboard.press("Enter");
    await page.keyboard.type("line2");
    expect(await blockKinds(page)).toEqual(["code"]);
    expect(await blockTexts(page)).toEqual(["line1\nline2"]);
  });

  test("Enter on an empty trailing line exits to a paragraph below", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("``` ");
    await page.keyboard.type("done()");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("prose continues");
    expect(await blockKinds(page)).toEqual(["code", "paragraph"]);
    // The blank exit line is consumed, not left in the code text.
    expect(await blockTexts(page)).toEqual(["done()", "prose continues"]);
  });
});
