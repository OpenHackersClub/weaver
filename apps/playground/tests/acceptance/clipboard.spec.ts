import { test, expect, type Page } from "@playwright/test";

/**
 * Clipboard acceptance tests — specs/lexical-parity.md §3
 * (COPY_COMMAND / CUT_COMMAND / PASTE_COMMAND → `clipboard.*`).
 *
 * The bridge writes `text/plain` plus the structured `application/x-weaver`
 * flavor on copy/cut and prefers the structured flavor on paste, so an
 * in-editor round-trip must preserve block kinds and marks — not just text.
 *
 * Headless Chromium does not emit clipboard events for synthesized
 * Ctrl+C / Ctrl+V keystrokes (they're handled in the browser UI layer, which
 * Playwright's keyboard bypasses — see microsoft/playwright#8114). The tests
 * therefore dispatch real `ClipboardEvent`s with a real `DataTransfer` from
 * inside the page: the production copy/cut/paste handlers in @weaver/dom run
 * unmodified; only the OS clipboard hop is simulated.
 */

const EMPTY_DOC_URL = "/?example=empty";
const WEAVER_MIME = "application/x-weaver";

declare global {
  interface Window {
    __weaverTestClipboard?: Record<string, string>;
  }
}

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

/** Dispatch copy/cut and stash what the bridge wrote to the DataTransfer. */
const dispatchCopyOrCut = (page: Page, type: "copy" | "cut") =>
  page.evaluate(
    ({ type, mime }) => {
      const host = document.querySelector("[data-weaver-root]")!;
      const dt = new DataTransfer();
      host.dispatchEvent(
        new ClipboardEvent(type, {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.__weaverTestClipboard = {
        "text/plain": dt.getData("text/plain"),
        [mime]: dt.getData(mime),
      };
    },
    { type, mime: WEAVER_MIME },
  );

/** Dispatch paste with the stashed flavors (or explicit overrides). */
const dispatchPaste = (page: Page, flavors?: Record<string, string>) =>
  page.evaluate(
    ({ flavors }) => {
      const host = document.querySelector("[data-weaver-root]")!;
      const stored = flavors ?? window.__weaverTestClipboard ?? {};
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(stored)) {
        if (value) dt.setData(type, value);
      }
      host.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { flavors: flavors ?? null },
  );

const blockTexts = async (page: Page): Promise<string[]> => {
  const blocks = page.locator("[data-weaver-root] [data-block-id]");
  const texts: string[] = [];
  for (let i = 0; i < (await blocks.count()); i++) {
    texts.push(
      (await blocks.nth(i).innerText()).replace(/[\u200B\u00A0]/g, "").trim(),
    );
  }
  return texts;
};

const blockKinds = async (page: Page): Promise<string[]> => {
  const blocks = page.locator("[data-weaver-root] [data-block-id]");
  const kinds: string[] = [];
  for (let i = 0; i < (await blocks.count()); i++) {
    kinds.push((await blocks.nth(i).getAttribute("data-kind")) ?? "");
  }
  return kinds;
};

test.describe("copy / paste round-trip", () => {
  test("copy then paste duplicates the selected text", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "copy");
    // Collapse to the end of the selection, then paste.
    await page.keyboard.press("ArrowRight");
    await dispatchPaste(page);
    expect(await blockTexts(page)).toEqual(["hellohello"]);
  });

  test("copy writes both text/plain and the structured weaver flavor", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "copy");
    const stored = await page.evaluate(() => window.__weaverTestClipboard);
    expect(stored!["text/plain"]).toBe("hello");
    const payload = JSON.parse(stored![WEAVER_MIME]!) as {
      blocks: ReadonlyArray<{ kind: string }>;
    };
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0]!.kind).toBe("paragraph");
  });

  test("structured paste preserves block kinds across blocks", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("# Head");
    await expect
      .poll(async () => await blockKinds(page))
      .toEqual(["paragraph", "heading"]);

    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "copy");
    await page.keyboard.press("ArrowRight");
    await dispatchPaste(page);

    // Pasting [paragraph "first", heading "Head"] at the end of the heading:
    // the first fragment merges into the anchor heading, the second lands as
    // a fresh heading block (Lexical $insertNodes semantics).
    expect(await blockTexts(page)).toEqual(["first", "Headfirst", "Head"]);
    expect(await blockKinds(page)).toEqual(["paragraph", "heading", "heading"]);
  });

  test("marks survive the clipboard round-trip", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("bold");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "copy");
    await page.keyboard.press("ArrowRight");
    await dispatchPaste(page);
    expect(await blockTexts(page)).toEqual(["boldbold"]);
    const html = (
      await page
        .locator("[data-weaver-root] [data-block-id]")
        .first()
        .innerHTML()
    ).toLowerCase();
    expect(html.replace(/<[^>]+>/g, "")).toContain("boldbold");
    // The pasted half re-applies the bold mark — the whole text renders bold,
    // not just the originally formatted run.
    const boldRuns = html.match(/<(strong|b)\b[^>]*>([^<]*)/g) ?? [];
    const boldText = boldRuns.map((r) => r.replace(/<[^>]+>/, "")).join("");
    expect(boldText).toContain("boldbold");
  });
});

test.describe("cut", () => {
  test("cut removes the selection and paste restores it", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "cut");
    expect(await blockTexts(page)).toEqual([""]);
    await dispatchPaste(page);
    expect(await blockTexts(page)).toEqual(["hello"]);
  });

  test("cutting a multi-block selection restores both blocks on paste", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Control+a");
    await dispatchCopyOrCut(page, "cut");
    expect(await blockTexts(page)).toEqual([""]);
    await dispatchPaste(page);
    expect(await blockTexts(page)).toEqual(["first", "second"]);
  });
});

test.describe("external plain-text paste", () => {
  test("multi-line plain text splits into blocks", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    // Simulate text copied from another app: plain text only, no weaver flavor.
    await dispatchPaste(page, { "text/plain": "one\ntwo\nthree" });
    expect(await blockTexts(page)).toEqual(["one", "two", "three"]);
    expect(await blockKinds(page)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
  });

  test("single-line plain text pastes inline at the caret", async ({
    page,
  }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("AB");
    await page.keyboard.press("ArrowLeft");
    await dispatchPaste(page, { "text/plain": "x" });
    expect(await blockTexts(page)).toEqual(["AxB"]);
  });
});
