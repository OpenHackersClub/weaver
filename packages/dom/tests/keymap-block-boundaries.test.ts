import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

/**
 * Block-boundary semantics added after the acceptance-test audit:
 *
 *  - Enter at the END of a heading/quote starts a paragraph (Lexical's
 *    `insertNewAfter`, Notion does the same); a mid-block split keeps the kind.
 *  - The `--- ` divider shortcut puts the caret in a fresh paragraph below
 *    (a divider has no inline text — typing into it used to throw).
 *  - Backspace at the start of a nested block outdents before merging.
 *  - Backspace/Delete merge with the *document-order* neighbour, so nested
 *    children adopted by `block.merge` are never lost.
 *  - The to-do checkbox affordance toggles `checked` on click.
 *  - Tab inside a code block inserts a literal tab, not block indentation.
 */

let f: DomFixture;
beforeEach(() => {
  f = setupDom();
});
afterEach(() => {
  f.destroy();
});

const placeCaret = (blockEl: HTMLElement, offset: number): void => {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let remaining = offset;
  while (node && remaining > node.length) {
    remaining -= node.length;
    node = walker.nextNode() as Text | null;
  }
  const sel = document.getSelection()!;
  const range = document.createRange();
  if (node) {
    range.setStart(node, remaining);
  } else {
    range.setStart(blockEl, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
};

describe("@weaver/dom / Enter at the end of a heading or quote", () => {
  it("heading + Enter at end yields a paragraph below", () => {
    f.type("# ");
    f.type("Title");
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["heading", "paragraph"]);
  });

  it("quote + Enter at end yields a paragraph below", () => {
    f.type("> ");
    f.type("quoted");
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["quote", "paragraph"]);
  });

  it("Enter in the MIDDLE of a heading keeps the tail a heading", () => {
    f.type("# ");
    f.type("alphabet");
    placeCaret(f.blockEls()[0]!, 5); // after "alpha"
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["heading", "heading"]);
    expect(f.blockTexts()).toEqual(["alpha", "bet"]);
  });

  it("list items still continue the list on Enter at end", () => {
    f.type("- ");
    f.type("item");
    f.press("insertParagraph");
    expect(f.blockKinds()).toEqual(["bullet-list-item", "bullet-list-item"]);
  });
});

describe("@weaver/dom / divider markdown shortcut", () => {
  it("'--- ' becomes a divider with a fresh paragraph below, and typing lands there", () => {
    f.type("--- ");
    expect(f.blockKinds()).toEqual(["divider", "paragraph"]);
    f.type("hello");
    expect(f.blockKinds()).toEqual(["divider", "paragraph"]);
    expect(f.blockTexts()).toEqual(["", "hello"]);
  });

  it("'*** ' also becomes a divider (not a bullet)", () => {
    f.type("*** ");
    expect(f.blockKinds()).toEqual(["divider", "paragraph"]);
  });

  it("Backspace with the caret on the divider's paragraph removes the divider", () => {
    f.type("--- ");
    // Caret is at offset 0 of the trailing paragraph; the visually previous
    // line is the divider — Backspace deletes it rather than merging.
    f.press("deleteContentBackward");
    expect(f.blockKinds()).toEqual(["paragraph"]);
  });
});

describe("@weaver/dom / Backspace and nesting", () => {
  const seedNestedPair = (): void => {
    f.type("- ");
    f.type("alpha");
    f.press("insertParagraph");
    f.type("beta");
    f.key("Tab"); // beta nested under alpha
  };

  it("Backspace at the start of a nested block outdents it (no kind demotion)", () => {
    seedNestedPair();
    const betaEl = f.blockEls()[1]!;
    expect(betaEl.getAttribute("data-depth")).toBe("1");
    placeCaret(betaEl, 0);
    f.press("deleteContentBackward");
    const depths = f.blockEls().map((el) => el.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "0"]);
    expect(f.blockKinds()).toEqual(["bullet-list-item", "bullet-list-item"]);
    expect(f.blockTexts()).toEqual(["alpha", "beta"]);
  });

  it("merging a block whose children are nested keeps the children (no data loss)", () => {
    f.type("first");
    f.press("insertParagraph");
    f.type("second");
    f.press("insertParagraph");
    f.type("third");
    f.key("Tab"); // third nested under second
    // Backspace at the start of "second" merges it into "first".
    placeCaret(f.blockEls()[1]!, 0);
    f.press("deleteContentBackward");
    expect(f.blockTexts()).toEqual(["firstsecond", "third"]);
    // "third" is now adopted under the merged block, still at depth 1.
    const depths = f.blockEls().map((el) => el.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "1"]);
  });

  it("Backspace at the start of a block after a nested run merges with the deepest previous line", () => {
    f.type("- ");
    f.type("alpha");
    f.press("insertParagraph");
    f.type("beta");
    f.key("Tab"); // beta nested under alpha
    // Add a top-level paragraph after alpha's subtree.
    placeCaret(f.blockEls()[1]!, "beta".length);
    f.press("insertParagraph");
    f.key("Tab", { shiftKey: true }); // bring the new block to top level...
    // (Enter split keeps it nested; one outdent puts it after alpha)
    f.type("gamma");
    // Caret to start of gamma, Backspace: the visually previous line is beta.
    const gammaEl = f.blockEls().find((el) => el.textContent?.includes("gamma"))!;
    placeCaret(gammaEl, 0);
    f.press("deleteContentBackward");
    expect(f.blockTexts()).toContain("betagamma");
  });
});

describe("@weaver/dom / to-do checkbox", () => {
  it("clicking the checkbox toggles checked on and off", () => {
    f.type("[ ] ");
    f.type("task");
    const check = f.host.querySelector("[data-todo-check]") as HTMLElement;
    expect(check.getAttribute("aria-checked")).toBe("false");

    check.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const checkAfter = f.host.querySelector("[data-todo-check]") as HTMLElement;
    expect(checkAfter.getAttribute("aria-checked")).toBe("true");

    checkAfter.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(
      (f.host.querySelector("[data-todo-check]") as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });

  it("the toggle is persisted on the block attrs in the LoroDoc", () => {
    f.type("[ ] ");
    f.type("task");
    const check = f.host.querySelector("[data-todo-check]") as HTMLElement;
    check.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const json = JSON.stringify(f.editor.doc.toJSON());
    expect(id).toBeTruthy();
    expect(json).toContain('"checked":true');
  });
});

describe("@weaver/dom / Tab inside a code block", () => {
  it("inserts a literal tab character instead of indenting the block", () => {
    f.type("``` ");
    expect(f.blockKinds()).toEqual(["code"]);
    f.type("if x:");
    f.key("Tab");
    expect(f.blockTexts()[0]).toBe("if x:\t");
    // Still a single top-level block — Tab did not restructure the tree.
    const depths = f.blockEls().map((el) => el.getAttribute("data-depth"));
    expect(depths).toEqual(["0"]);
  });
});
