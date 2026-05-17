import { test, expect, type Page } from "@playwright/test";

/**
 * Acceptance tests against the Weaver Playground.
 *
 * These tests assert the spec-level outcomes from `specs/playground.md` and
 * `specs/block-model.md` — they should fail in CI when the implementation
 * drifts from the spec. They use only the *deployed shape* of the app
 * (DOM + URL params + window globals exposed for debugging), never internals.
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator('[data-weaver-root]');
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

const blockTexts = async (page: Page): Promise<string[]> => {
  return page.$$eval('[data-weaver-root] [data-block-id]', (nodes) =>
    nodes.map((n) => (n.textContent ?? "").replace(/​/g, "")),
  );
};

const blockKinds = async (page: Page): Promise<string[]> => {
  return page.$$eval('[data-weaver-root] [data-block-id]', (nodes) =>
    nodes.map((n) => n.getAttribute("data-kind") ?? ""),
  );
};

test.describe("editor mounts and renders", () => {
  test("base route returns the playground shell", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await page.goto(EMPTY_DOC_URL);
    await expect(page.locator('[data-weaver-root]')).toBeVisible();
    await expect(page.locator('[data-weaver-root] [data-block-id]')).toHaveCount(1);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("default block on the empty example is a paragraph", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    const kinds = await blockKinds(page);
    expect(kinds).toEqual(["paragraph"]);
  });
});

test.describe("typing into a paragraph", () => {
  test("typed characters appear in the DOM", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello world");
    await expect(page.locator('[data-weaver-root] [data-block-id]').first()).toHaveText(
      "hello world",
    );
  });

  test("typed characters land in the LoroDoc (source of truth)", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("loro is the truth");
    // The playground exposes a debug snapshot on window.__weaver_debug for tests.
    const snapshot = await page.evaluate(() =>
      (window as unknown as { __weaver_debug?: { snapshot: () => unknown } })
        .__weaver_debug?.snapshot(),
    );
    expect(JSON.stringify(snapshot)).toContain("loro is the truth");
  });
});

test.describe("Enter splits a block", () => {
  test("pressing Enter at end of paragraph creates a new paragraph below", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await expect(page.locator('[data-weaver-root] [data-block-id]')).toHaveCount(2);
    expect(await blockTexts(page)).toEqual(["first", "second"]);
    expect(await blockKinds(page)).toEqual(["paragraph", "paragraph"]);
  });

  test("pressing Enter in the middle splits the text correctly", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("alphabet");
    // Move caret to after "alpha" (5 chars from end means press Left 3 times).
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    expect(await blockTexts(page)).toEqual(["alpha", "bet"]);
  });
});

test.describe("Backspace at the start of a block", () => {
  test("merges into the previous block", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    // Caret is at end of "second"; move to start.
    for (let i = 0; i < "second".length; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    expect(await blockTexts(page)).toEqual(["firstsecond"]);
  });
});

test.describe("markdown shortcut", () => {
  test("'# ' at start of paragraph transforms it to heading level 1", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("# ");
    expect(await blockKinds(page)).toEqual(["heading"]);
    await page.keyboard.type("Title");
    expect(await blockTexts(page)).toEqual(["Title"]);
    await expect(page.locator('[data-weaver-root] [data-block-id]').first()).toHaveAttribute(
      "data-level",
      "1",
    );
  });

  test("'## ' transforms to heading level 2", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("## ");
    expect(await blockKinds(page)).toEqual(["heading"]);
    await expect(page.locator('[data-weaver-root] [data-block-id]').first()).toHaveAttribute(
      "data-level",
      "2",
    );
  });
});

test.describe("bold mark", () => {
  test("Ctrl+B toggles bold on the selection", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    const html = await page.locator('[data-weaver-root] [data-block-id]').first().innerHTML();
    expect(html.toLowerCase()).toMatch(/<(strong|b)\b/);
  });
});

test.describe("debug overlay", () => {
  test("?debug=tree renders the block-tree panel", async ({ page }) => {
    await page.goto(`${EMPTY_DOC_URL}&debug=tree`);
    await expect(page.locator('[data-weaver-debug-panel="tree"]')).toBeVisible();
  });

  test("?debug=ops renders the op-log panel and records edits", async ({ page }) => {
    await page.goto(`${EMPTY_DOC_URL}&debug=ops`);
    await expect(page.locator('[data-weaver-debug-panel="ops"]')).toBeVisible();
    await focusEditor(page);
    await page.keyboard.type("x");
    const opLogText = await page.locator('[data-weaver-debug-panel="ops"]').innerText();
    expect(opLogText).toMatch(/origin/i);
  });
});
