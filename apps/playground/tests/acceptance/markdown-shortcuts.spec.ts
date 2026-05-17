import { test, expect, type Page } from "@playwright/test";

/**
 * Markdown-shortcut acceptance tests against the deployed playground.
 *
 * Lexical's `Markdown.spec.mjs` exercises the full shortcut set. weaver
 * currently ships only the `# `..`###### ` heading shortcut (see
 * `packages/dom/src/keymap.ts`). Everything else here is a TDD-red target
 * pinned from `specs/lexical-parity.md` §4 (MarkdownShortcutPlugin).
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

const firstBlock = (page: Page) =>
  page.locator("[data-weaver-root] [data-block-id]").first();

test.describe("markdown shortcuts — headings", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    test(`'${"#".repeat(level)} ' transforms to heading level ${level}`, async ({
      page,
    }) => {
      await page.goto(EMPTY_DOC_URL);
      await focusEditor(page);
      await page.keyboard.type(`${"#".repeat(level)} `);
      expect(await blockKinds(page)).toEqual(["heading"]);
      await expect(firstBlock(page)).toHaveAttribute(
        "data-level",
        String(level),
      );
    });
  }

  test("'####### ' (7 hashes) stays a paragraph", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("####### ");
    expect(await blockKinds(page)).toEqual(["paragraph"]);
  });
});

test.describe("markdown shortcuts — block kinds", () => {
  test("'> ' transforms to a quote", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("> ");
    expect(await blockKinds(page)).toEqual(["quote"]);
  });

  test("'- ' transforms to a bullet list item", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- ");
    expect(await blockKinds(page)).toEqual(["bullet-list-item"]);
  });

  test("'* ' transforms to a bullet list item", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("* ");
    expect(await blockKinds(page)).toEqual(["bullet-list-item"]);
  });

  test("'1. ' transforms to a numbered list item", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("1. ");
    expect(await blockKinds(page)).toEqual(["numbered-list-item"]);
  });

  test("'[ ] ' transforms to an unchecked to-do", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("[ ] ");
    expect(await blockKinds(page)).toEqual(["to-do"]);
  });

  // `code` and `divider` are committed v1 block kinds in lexical-parity.md §1
  // but are not yet in `BlockKindSchema` (packages/core/src/block.ts). These
  // two need the schema extended before the shortcut can be wired — a larger
  // change than the other shortcuts above.
  test("'```' + space opens a code block (needs `code` in BlockKindSchema)", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("``` ");
    expect(await blockKinds(page)).toEqual(["code"]);
  });

  test("'--- ' inserts a divider (needs `divider` in BlockKindSchema)", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("--- ");
    expect(await blockKinds(page)).toContain("divider");
  });
});

test.describe("markdown shortcuts — content after the shortcut", () => {
  test("typing after '# ' goes into the heading, not the consumed markdown", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("# Heading text");
    await expect(firstBlock(page)).toHaveText("Heading text");
  });

  test("Enter after a list-item shortcut keeps the list going", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    expect(await blockKinds(page)).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
  });
});
