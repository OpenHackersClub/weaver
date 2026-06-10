import { test, expect, type Page } from "@playwright/test";

/**
 * List + indent/outdent acceptance tests.
 *
 * `block.indent` / `block.outdent`, the Tab / Shift-Tab keymap, and the
 * `- ` / `1. ` / `[ ] ` markdown shortcuts are implemented.
 * `specs/lexical-parity.md` §1 models nested lists as the block tree's
 * children; §3 commits to INDENT/OUTDENT. Mirrors Lexical's
 * `Indentation.spec.mjs` and `List.spec.mjs`.
 *
 * The DOM renders the whole tree as flat siblings in document order with a
 * `data-depth` attribute (see `block-boundaries.spec.ts` for the DOM-level
 * guards). The assertions here read the *block tree* via
 * `window.__weaver_debug.tree()` — the LoroDoc, the single source of truth —
 * so structural nesting is verified independently of the renderer.
 */

interface DebugTreeNode {
  readonly id: string;
  readonly kind: string | null;
  readonly children: ReadonlyArray<DebugTreeNode>;
}

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

/** The block tree from the LoroDoc — reveals nesting the flat DOM hides. */
const docTree = (page: Page): Promise<DebugTreeNode[]> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __weaver_debug: { tree: () => DebugTreeNode[] };
        }
      ).__weaver_debug.tree(),
  );

test.describe("list creation", () => {
  test("two bullet items via shortcut + Enter", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    expect(await blockKinds(page)).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
  });

  test("Enter on an empty list item exits the list back to a paragraph", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- item");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter"); // second Enter on the empty item
    const kinds = await blockKinds(page);
    // The list-exit feature is only meaningful if a list item existed in the
    // first place — assert both, so the test fails when list shortcuts break.
    expect(kinds).toContain("bullet-list-item");
    expect(kinds[kinds.length - 1]).toBe("paragraph");
  });
});

test.describe("indent / outdent", () => {
  test("Tab nests a list item under its predecessor", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    // Precondition: both must be real list items (fails today — `- ` shortcut
    // is unimplemented).
    expect(await blockKinds(page)).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
    await page.keyboard.press("Tab");

    const tree = await docTree(page);
    // beta is now a child of alpha — one root item with one nested child.
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.kind).toBe("bullet-list-item");
  });

  test("Shift+Tab outdents a nested item back to the top level", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    expect(await blockKinds(page)).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");

    const tree = await docTree(page);
    // Back to two flat root-level items, neither nested.
    expect(tree).toHaveLength(2);
    expect(tree[0]!.children).toHaveLength(0);
    expect(tree[1]!.children).toHaveLength(0);
  });

  test("Tab at the first list item does nothing (no predecessor to nest under)", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("- only");
    expect(await blockKinds(page)).toEqual(["bullet-list-item"]);
    const before = await docTree(page);
    await page.keyboard.press("Tab");
    const after = await docTree(page);
    expect(after).toEqual(before);
  });
});

test.describe("to-do checkbox", () => {
  test("a to-do block renders a checkbox affordance", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("[ ] task");
    const first = page.locator("[data-weaver-root] [data-block-id]").first();
    await expect(first).toHaveAttribute("data-kind", "to-do");
    // The checkbox is an input or a clickable [data-todo-check] affordance.
    const hasCheckable = await first.evaluate(
      (el) =>
        el.querySelector('input[type="checkbox"], [data-todo-check]') !== null,
    );
    expect(hasCheckable).toBe(true);
  });
});
