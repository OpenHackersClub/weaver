/**
 * Polyfill `CSS.escape` for jsdom, which doesn't expose the global `CSS` object.
 * The bridge uses `CSS.escape` in `findBlockElement` for selector building;
 * without this, every test that touches the bridge crashes.
 *
 * Spec: https://drafts.csswg.org/cssom/#serialize-an-identifier
 */
if (typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ===
  "undefined") {
  // Minimal implementation — handles the characters that appear in our
  // block IDs (Loro TreeIDs of shape `<counter>@<peerId>`).
  const escape = (s: string): string =>
    String(s).replace(
      /[!"#$%&'()*+,./:;<=>?@[\]^`{|}~]/g,
      (ch) => `\\${ch}`,
    );
  (globalThis as { CSS?: { escape: (s: string) => string } }).CSS = { escape };
}

// jsdom exposes `queueMicrotask` but some bridge code paths assume `Promise`
// microtasks land before the next event tick; vitest's jsdom env handles this
// natively. No additional setup needed here.
