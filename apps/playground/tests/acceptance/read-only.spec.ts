import { test, expect, type Page } from "@playwright/test";

/**
 * Read-only mode acceptance — specs/lexical-parity.md §3
 * ("Read-only mode | editor.setEditable(false) toggle").
 *
 * Drives the real editor surface: while read-only the DOM must report
 * contenteditable=false and real keystrokes must not mutate the document;
 * re-enabling restores editing. The editable flag is flipped through the
 * playground's `__weaver_debug` handle (the same channel structural
 * assertions already use).
 */

const EMPTY_DOC_URL = "/?example=empty";

declare global {
  interface Window {
    __weaver_debug?: {
      setEditable: (editable: boolean) => void;
      isEditable: () => boolean;
    };
  }
}

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

const firstBlockText = async (page: Page): Promise<string> =>
  (
    await page.locator("[data-weaver-root] [data-block-id]").first().innerText()
  ).replace(/[​ ]/g, "");

test("setEditable(false) blocks typing; setEditable(true) restores it", async ({
  page,
}) => {
  await page.goto(EMPTY_DOC_URL);
  const editor = await focusEditor(page);
  await page.keyboard.type("hello");
  expect(await firstBlockText(page)).toBe("hello");

  await page.evaluate(() => window.__weaver_debug!.setEditable(false));
  await expect(editor).toHaveAttribute("contenteditable", "false");
  // Keystrokes while read-only must not reach the document.
  await editor.click();
  await page.keyboard.type("XYZ");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  expect(await firstBlockText(page)).toBe("hello");
  expect(
    await page.locator("[data-weaver-root] [data-block-id]").count(),
  ).toBe(1);

  await page.evaluate(() => window.__weaver_debug!.setEditable(true));
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  expect(await firstBlockText(page)).toBe("hello!");
});
