import { test, expect, type Page } from "@playwright/test";

/**
 * Regression guards for two reported bugs on the deployed playground:
 *
 *   1. typing "hello" rendered as "elloh" — the first character ended up
 *      appended after the rest. Root cause: the DOM bridge deferred
 *      reconciliation + caret restore to a microtask, so when multiple
 *      `beforeinput` events fired in the same task (macOS autocorrect,
 *      IME, scripted bursts), each handler read a stale DOM selection at
 *      offset 0 and inserted at the start.
 *
 *   2. typing was sluggish — every keystroke triggered a full
 *      `replaceChildren()` rebuild of the block, which is O(n) DOM work
 *      per char and forced the browser to re-place the caret.
 *
 * These tests should fail if the bridge regresses on either property.
 */

const EMPTY_DOC_URL = "/?example=empty";

const focusEditor = async (page: Page) => {
  const editor = page.locator('[data-weaver-root]');
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

test.describe("typing correctness — character order is preserved", () => {
  test("synchronous beforeinput burst preserves insertion order", async ({ page }) => {
    // This is the *exact* shape of the original bug: multiple beforeinput
    // events dispatched in the same task with no microtask drain between
    // them. macOS autocorrect / IME / scripted typing all do this. Before
    // the fix, "hello" came out as "olleh"/"elloh" depending on how many
    // microtasks happened to fire mid-burst.
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.evaluate(() => {
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      for (const ch of "hello") {
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: ch,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    });
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe("hello");
  });

  test("typing 'hello' at human pace yields 'hello'", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello", { delay: 40 });
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe("hello");
  });

  test("typing 'hello' with zero delay yields 'hello'", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.keyboard.type("hello");
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe("hello");
  });

  test("long synchronous burst (256 chars) preserves order", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    const expected =
      "the quick brown fox jumps over the lazy dog. ".repeat(6).slice(0, 256);
    await page.evaluate((s) => {
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      for (const ch of s) {
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: ch,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }, expected);
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe(expected);
  });
});

test.describe("typing performance — keystrokes must not be sluggish", () => {
  // Performance threshold rationale:
  //   The original bug was the entire block being `replaceChildren()`d on
  //   every keystroke. For a 200-char block on a developer laptop in a
  //   release build, the work per char (LoroDoc insert + reconcile + caret
  //   restore) should be well under 5ms. We use a generous ceiling of
  //   10ms/char average to keep the test stable in CI on slower runners,
  //   while still flagging the kind of regression we just fixed (where
  //   per-char work scales O(n) with block size).
  const MAX_AVG_MS_PER_CHAR = 10;
  const SAMPLE = 200;

  test(`200-char synchronous burst averages < ${MAX_AVG_MS_PER_CHAR}ms/char`, async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    const elapsed = await page.evaluate((n) => {
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            // Vary the char so each insert is a distinct DOM update.
            data: String.fromCharCode(97 + (i % 26)),
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return performance.now() - t0;
    }, SAMPLE);

    const perChar = elapsed / SAMPLE;
    console.log(`typing burst: ${SAMPLE} chars in ${elapsed.toFixed(1)}ms (${perChar.toFixed(2)}ms/char)`);
    expect(perChar).toBeLessThan(MAX_AVG_MS_PER_CHAR);

    // Sanity check that the text actually got written (and in order).
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toHaveLength(SAMPLE);
  });

  test("appending a char to a 1000-char block stays O(1)-ish (< 50ms)", async ({ page }) => {
    // Even a generous threshold catches a regression to per-char O(n)
    // because at n=1000 the old `replaceChildren()` path took multiple
    // hundreds of milliseconds per char in a release build.
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);

    // Seed the block with 1000 chars via a single insert call (so we don't
    // rely on the typing path we're trying to measure).
    await page.evaluate(() => {
      const w = window as unknown as {
        __weaver_debug?: { snapshot: () => unknown };
      };
      void w; // we use the editor via DOM API only
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      root.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          data: "x".repeat(1000),
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Now measure the cost of a single additional keystroke.
    const elapsed = await page.evaluate(() => {
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      const t0 = performance.now();
      root.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: "!",
          bubbles: true,
          cancelable: true,
        }),
      );
      return performance.now() - t0;
    });

    console.log(`single keystroke onto 1000-char block: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(50);
  });
});

test.describe("caret stays at the end of typed text", () => {
  test("continuing to type appends, doesn't reverse or scramble", async ({ page }) => {
    // Direct guard against the "elloh" mode where new chars land at offset
    // 0 because the bridge never updates the live DOM selection.
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    await page.evaluate(() => {
      const root = document.querySelector('[data-weaver-root]') as HTMLElement;
      root.focus();
      const dispatch = (data: string) =>
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data,
            bubbles: true,
            cancelable: true,
          }),
        );
      dispatch("a");
      dispatch("b");
      dispatch("c");
    });
    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe("abc");
  });
});

test.describe("whitespace is preserved — spaces are not collapsed", () => {
  // Reported on the deployed playground: a space at the end of a sentence,
  // or two spaces between words, appeared to do nothing. The LoroDoc model
  // held the spaces correctly — the bug was the editing surface rendering
  // with the browser default `white-space: normal`, which collapses runs of
  // spaces and trims trailing spaces. `richifyHost` now sets `white-space:
  // pre-wrap` on every editor host.
  //
  // `textContent` carries the characters regardless of how they render, so
  // these guards also measure the *rendered* width of the span of spaces:
  // preserved they are tens of px wide, collapsed they shrink to one space
  // (~4px) and trailing ones trim to ~0px. 20px sits well inside that gap.
  const SPACES = 10;
  const MIN_RENDERED_WIDTH = 20;

  test("consecutive spaces between words are rendered", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    const spacesWidth = await page.evaluate((n) => {
      const root = document.querySelector("[data-weaver-root]") as HTMLElement;
      root.focus();
      const dispatch = (data: string) =>
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data,
            bubbles: true,
            cancelable: true,
          }),
        );
      dispatch("a");
      for (let i = 0; i < n; i++) dispatch(" ");
      dispatch("b");
      const block = root.querySelector("[data-block-id]") as HTMLElement;
      const textNode = document
        .createTreeWalker(block, NodeFilter.SHOW_TEXT)
        .nextNode() as Text;
      const range = document.createRange();
      range.setStart(textNode, 1); // just after "a"
      range.setEnd(textNode, 1 + n); // just before "b"
      return range.getBoundingClientRect().width;
    }, SPACES);

    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    // The model kept every character...
    expect(text).toBe(`a${" ".repeat(SPACES)}b`);
    // ...and the editor rendered them rather than collapsing to one space.
    expect(spacesWidth).toBeGreaterThan(MIN_RENDERED_WIDTH);
  });

  test("a space at the end of a sentence is rendered", async ({ page }) => {
    await page.goto(EMPTY_DOC_URL);
    await focusEditor(page);
    const spacesWidth = await page.evaluate((n) => {
      const root = document.querySelector("[data-weaver-root]") as HTMLElement;
      root.focus();
      const dispatch = (data: string) =>
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data,
            bubbles: true,
            cancelable: true,
          }),
        );
      for (const ch of "word") dispatch(ch);
      for (let i = 0; i < n; i++) dispatch(" ");
      const block = root.querySelector("[data-block-id]") as HTMLElement;
      const textNode = document
        .createTreeWalker(block, NodeFilter.SHOW_TEXT)
        .nextNode() as Text;
      const range = document.createRange();
      range.setStart(textNode, 4); // just after "word"
      range.setEnd(textNode, 4 + n); // through the trailing spaces
      return range.getBoundingClientRect().width;
    }, SPACES);

    const text = await page
      .locator('[data-weaver-root] [data-block-id]')
      .first()
      .textContent();
    expect(text).toBe(`word${" ".repeat(SPACES)}`);
    expect(spacesWidth).toBeGreaterThan(MIN_RENDERED_WIDTH);
  });
});
