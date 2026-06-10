import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDomSelection } from "../src/selection-mapper.js";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

/**
 * Bridge-level keymap tests — drive the DOM bridge via `beforeinput` /
 * `keydown` and assert what the editor (DOM and LoroDoc) look like
 * afterwards. These mirror the e2e style in `apps/playground/tests/acceptance`
 * but run in jsdom for fast unit-level coverage.
 */

let f: DomFixture;
beforeEach(() => {
  f = setupDom();
});
afterEach(() => {
  f.destroy();
});

describe("@weaver/dom / typing", () => {
  it("a single insertText event appends the character to the focused block", () => {
    f.press("insertText", "a");
    expect(f.blockTexts()).toEqual(["a"]);
  });

  it("a burst of insertText events preserves order (regression — 'hello' must stay 'hello')", () => {
    f.type("hello");
    expect(f.blockTexts()).toEqual(["hello"]);
  });

  it("typing leaves exactly one block (no spurious split)", () => {
    f.type("foo bar baz");
    expect(f.blockEls()).toHaveLength(1);
  });
});

describe("@weaver/dom / Enter splits the current block", () => {
  it("Enter at end of paragraph creates a new empty paragraph", () => {
    f.type("first");
    f.press("insertParagraph");
    expect(f.blockEls()).toHaveLength(2);
    expect(f.blockKinds()).toEqual(["paragraph", "paragraph"]);
    expect(f.blockTexts()).toEqual(["first", ""]);
  });

  it("Enter twice yields three blocks", () => {
    f.type("a");
    f.press("insertParagraph");
    f.type("b");
    f.press("insertParagraph");
    expect(f.blockEls()).toHaveLength(3);
    expect(f.blockTexts()).toEqual(["a", "b", ""]);
  });

  it("Shift+Enter is a *soft* line break — stays in one block", () => {
    // specs/lexical-parity.md §1 LineBreakNode → "inline ` ` or `<br>` analog
    // inside `LoroText`". The firm contract pinned here is *no new block*;
    // whether the break is encoded as a character or an inline node is the
    // implementer's choice, so the test only checks block count + text.
    f.type("alpha");
    f.press("insertLineBreak");
    f.type("beta");
    expect(f.blockEls()).toHaveLength(1);
    expect(f.blockTexts()[0]).toContain("alpha");
    expect(f.blockTexts()[0]).toContain("beta");
  });
});

describe("@weaver/dom / Enter inside a code block (PR #34 follow-up)", () => {
  it("Enter is a soft newline — code lines stay in ONE block", () => {
    f.type("``` ");
    f.type("line1");
    f.press("insertParagraph");
    f.type("line2");
    expect(f.blockKinds()).toEqual(["code"]);
    expect(f.blockTexts()).toEqual(["line1\nline2"]);
  });

  it("Enter on an empty trailing line exits to a fresh paragraph", () => {
    f.type("``` ");
    f.type("const x = 1");
    f.press("insertParagraph"); // soft newline → empty trailing line
    f.press("insertParagraph"); // exit: blank line consumed, paragraph below
    f.type("after");
    expect(f.blockKinds()).toEqual(["code", "paragraph"]);
    // The blank exit line never lands in the code text.
    expect(f.blockTexts()).toEqual(["const x = 1", "after"]);
  });

  it("Enter in an empty code block stays inside (newline first, exit second)", () => {
    f.type("``` ");
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["code"]);
    expect(f.blockTexts()).toEqual(["\n"]);
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["code", "paragraph"]);
    expect(f.blockTexts()).toEqual(["", ""]);
  });
});

describe("@weaver/dom / Backspace", () => {
  it("Backspace at offset > 0 deletes the previous character", () => {
    f.type("abc");
    f.press("deleteContentBackward");
    expect(f.blockTexts()).toEqual(["ab"]);
  });

  it("Backspace at offset 0 in a paragraph following another merges the two", () => {
    f.type("first");
    f.press("insertParagraph");
    f.type("second");
    // Move caret to start of second block by simulating arrow-lefts equal to
    // its length. We can't (yet) drive arrow keys through the bridge — manual
    // selection assignment serves the test.
    const second = f.blockEls()[1]!;
    const text = second.firstChild as Text | null;
    const range = document.createRange();
    if (text) {
      range.setStart(text, 0);
      range.setEnd(text, 0);
    } else {
      range.setStart(second, 0);
      range.setEnd(second, 0);
    }
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteContentBackward");
    expect(f.blockEls()).toHaveLength(1);
    expect(f.blockTexts()).toEqual(["firstsecond"]);
  });

  it("Backspace at offset 0 of a heading with no prev demotes to paragraph", () => {
    // Build a heading via markdown shortcut.
    f.type("# ");
    expect(f.blockKinds()).toEqual(["heading"]);
    f.type("Title");

    // Move caret to start of the only block.
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text | null;
    const range = document.createRange();
    if (text) {
      range.setStart(text, 0);
      range.setEnd(text, 0);
    } else {
      range.setStart(block, 0);
      range.setEnd(block, 0);
    }
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteContentBackward");
    expect(f.blockKinds()).toEqual(["paragraph"]);
    expect(f.blockTexts()).toEqual(["Title"]);
  });
});

describe("@weaver/dom / Option+Backspace (deleteWordBackward)", () => {
  it("deletes the trailing word, leaving any preceding text intact", () => {
    f.type("hello world");
    f.press("deleteWordBackward");
    expect(f.blockTexts()).toEqual(["hello "]);
  });

  it("a second press consumes the trailing space and the previous word", () => {
    f.type("hello world");
    f.press("deleteWordBackward");
    f.press("deleteWordBackward");
    expect(f.blockTexts()).toEqual([""]);
  });

  it("at offset 0 falls back to block-merge backspace", () => {
    f.type("first");
    f.press("insertParagraph");
    f.type("second");
    const second = f.blockEls()[1]!;
    const text = second.firstChild as Text | null;
    const range = document.createRange();
    if (text) {
      range.setStart(text, 0);
      range.setEnd(text, 0);
    } else {
      range.setStart(second, 0);
      range.setEnd(second, 0);
    }
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteWordBackward");
    expect(f.blockEls()).toHaveLength(1);
    expect(f.blockTexts()).toEqual(["firstsecond"]);
  });
});

describe("@weaver/dom / Option+Delete (deleteWordForward)", () => {
  it("from offset 0 deletes the leading word", () => {
    f.type("hello world");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 0);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteWordForward");
    expect(f.blockTexts()).toEqual([" world"]);
  });

  it("a second press from offset 0 consumes the leading space and next word", () => {
    f.type("hello world");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 0);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteWordForward");
    f.press("deleteWordForward");
    expect(f.blockTexts()).toEqual([""]);
  });
});

describe("@weaver/dom / Cmd+Backspace (deleteSoftLineBackward)", () => {
  it("deletes to the start of the block when there is no soft break", () => {
    f.type("hello world");
    f.press("deleteSoftLineBackward");
    expect(f.blockTexts()).toEqual([""]);
  });

  it("only deletes the current line when soft line breaks are present", () => {
    f.type("alpha");
    f.press("insertLineBreak");
    f.type("beta");
    // Caret is at end after `type()`.
    f.press("deleteSoftLineBackward");
    expect(f.blockTexts()).toEqual(["alpha\n"]);
  });

  it("a second press removes the soft break (falls through to char-backspace)", () => {
    f.type("alpha");
    f.press("insertLineBreak");
    f.type("beta");
    f.press("deleteSoftLineBackward");
    // Now `alpha\n` with caret at end. Char-backspace removes the `\n`.
    f.press("deleteSoftLineBackward");
    expect(f.blockTexts()).toEqual(["alpha"]);
  });

  it("`deleteHardLineBackward` follows the same handler", () => {
    f.type("hello world");
    f.press("deleteHardLineBackward");
    expect(f.blockTexts()).toEqual([""]);
  });
});

describe("@weaver/dom / Ctrl+K (deleteSoftLineForward)", () => {
  it("from offset 0 deletes to the next soft line break", () => {
    f.type("alpha");
    f.press("insertLineBreak");
    f.type("beta");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 0);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteSoftLineForward");
    expect(f.blockTexts()).toEqual(["\nbeta"]);
  });

  it("with no trailing newline deletes to the end of the block", () => {
    f.type("hello");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 0);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteSoftLineForward");
    expect(f.blockTexts()).toEqual([""]);
  });
});

describe("@weaver/dom / Cmd+X (deleteByCut) and drag-out (deleteByDrag)", () => {
  it("deleteByCut removes the selected range from the block", () => {
    f.type("hello");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteByCut");
    expect(f.blockTexts()).toEqual(["ho"]);
  });

  it("deleteByDrag removes the source-side range", () => {
    f.type("hello");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteByDrag");
    expect(f.blockTexts()).toEqual(["lo"]);
  });
});

describe("@weaver/dom / Safari history beforeinput", () => {
  it("historyUndo undoes the last typing batch", () => {
    f.type("hello");
    f.press("historyUndo");
    expect(f.blockTexts()).toEqual([""]);
  });

  it("historyRedo redoes after an undo", () => {
    f.type("hello");
    f.press("historyUndo");
    expect(f.blockTexts()).toEqual([""]);
    f.press("historyRedo");
    expect(f.blockTexts()).toEqual(["hello"]);
  });
});

describe("@weaver/dom / formatting via Ctrl+B / Ctrl+I / Ctrl+U", () => {
  it("Ctrl+B over a selection toggles bold on the LoroDoc text", () => {
    f.type("hello");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.key("b", { ctrlKey: true });
    const id = block.getAttribute("data-block-id")!;
    expect(f.editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { bold: true } },
    ]);
  });
});

describe("@weaver/dom / undo & redo via keyboard", () => {
  it("Ctrl+Z undoes the last typing batch", () => {
    f.type("hello");
    f.key("z", { ctrlKey: true });
    expect(f.blockTexts()).toEqual([""]);
  });

  it("Ctrl+Shift+Z redoes after an undo", () => {
    f.type("hello");
    f.key("z", { ctrlKey: true });
    // Intermediate assertion: undo must genuinely empty the block. Without
    // this the test would pass vacuously (a no-op undo + no-op redo both
    // leave "hello"). This line is what makes the test red today.
    expect(f.blockTexts()).toEqual([""]);
    f.key("z", { ctrlKey: true, shiftKey: true });
    expect(f.blockTexts()).toEqual(["hello"]);
  });
});

describe("@weaver/dom / Ctrl+A select-all", () => {
  it("Ctrl+A selects from the start of the first block to the end of the last", () => {
    f.type("first");
    f.press("insertParagraph");
    f.type("second");
    f.key("a", { ctrlKey: true });
    // Assert the bridge's own DomRange rather than `Selection.toString()`,
    // which is unreliable for multi-node ranges under jsdom.
    const ids = f.blockEls().map((el) => el.getAttribute("data-block-id"));
    const range = readDomSelection(f.host);
    expect(range).not.toBeNull();
    expect(range!.anchor).toEqual({ blockId: ids[0], offset: 0 });
    expect(range!.focus).toEqual({ blockId: ids[1], offset: 6 });
  });
});

describe("@weaver/dom / Tab / Shift-Tab indent / outdent", () => {
  // Nested blocks render as flat DOM siblings in document order, indented
  // via `data-depth` — they must never disappear from the DOM (regression:
  // the pre-`documentOrderWithDepth` reconciler only rendered root children,
  // so indenting a block removed its element entirely).
  it("Tab on a bullet-list-item nests it in the tree and keeps it rendered", () => {
    // Seed two list items: `- ` shortcut, then Enter continues the list.
    f.type("- ");
    f.type("alpha");
    f.press("insertParagraph");
    f.type("beta");

    expect(f.blockKinds()).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
    f.key("Tab");

    // Both blocks stay in the DOM; the indented one carries data-depth=1.
    expect(f.blockTexts()).toEqual(["alpha", "beta"]);
    const depths = f.blockEls().map((el) => el.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "1"]);
    // And the LoroDoc tree really nests beta under alpha.
    const [alphaId] = f.blockEls().map((el) => el.getAttribute("data-block-id"));
    const { getChildren } = f;
    expect(getChildren(alphaId!)).toHaveLength(1);
  });

  it("Shift+Tab on a nested item outdents it back to depth 0", () => {
    f.type("- ");
    f.type("alpha");
    f.press("insertParagraph");
    f.type("beta");
    // Precondition: the `- ` shortcut must have produced real list items.
    // Without this assertion the test passes vacuously (paragraphs stay
    // top-level whether or not Tab/Shift+Tab do anything).
    expect(f.blockKinds()).toEqual([
      "bullet-list-item",
      "bullet-list-item",
    ]);
    f.key("Tab");
    f.key("Tab", { shiftKey: true });

    const depths = f.blockEls().map((el) => el.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "0"]);
    const [alphaId] = f.blockEls().map((el) => el.getAttribute("data-block-id"));
    expect(f.getChildren(alphaId!)).toHaveLength(0);
  });
});

describe("@weaver/dom / Delete forward", () => {
  it("Delete at offset < length removes the character to the right", () => {
    f.type("abc");
    const block = f.blockEls()[0]!;
    const text = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 1);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteContentForward");
    expect(f.blockTexts()).toEqual(["ac"]);
  });

  it("Delete at end of block merges into next sibling", () => {
    f.type("first");
    f.press("insertParagraph");
    f.type("second");
    const first = f.blockEls()[0]!;
    const text = first.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, "first".length);
    range.setEnd(text, "first".length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    f.press("deleteContentForward");
    expect(f.blockTexts()).toEqual(["firstsecond"]);
  });
});
