import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachEditor } from "../src/index.js";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

/**
 * Read-only mode — specs/lexical-parity.md §3 "Read-only mode |
 * editor.setEditable(false) toggle". The core flag alone is not enough: the
 * DOM bridge must mirror it onto `contenteditable` and refuse model mutations
 * while read-only, otherwise the surface still accepts edits.
 */

let f: DomFixture;
beforeEach(() => {
  f = setupDom();
});
afterEach(() => {
  f.destroy();
});

describe("@weaver/dom / read-only mode", () => {
  it("setEditable(false) flips contenteditable off and back on", () => {
    expect(f.host.getAttribute("contenteditable")).toBe("true");
    f.editor.setEditable(false);
    expect(f.host.getAttribute("contenteditable")).toBe("false");
    f.editor.setEditable(true);
    expect(f.host.getAttribute("contenteditable")).toBe("true");
  });

  it("attaching to an already read-only editor renders contenteditable=false", () => {
    f.editor.setEditable(false);
    // Re-attach: detach + attach to the same host.
    f.bridge.detach();
    const bridge = attachEditor(f.editor, f.host);
    expect(f.host.getAttribute("contenteditable")).toBe("false");
    bridge.detach();
    f.editor.setEditable(true);
  });

  it("beforeinput mutations are ignored while read-only", () => {
    f.type("hello");
    f.editor.setEditable(false);
    f.press("insertText", "X");
    f.press("deleteContentBackward");
    f.press("insertParagraph");
    expect(f.blockTexts()).toEqual(["hello"]);
    expect(f.blockEls()).toHaveLength(1);
  });

  it("keyboard formatting and undo shortcuts are ignored while read-only", () => {
    f.type("hello");
    f.editor.setEditable(false);
    f.key("z", { ctrlKey: true });
    expect(f.blockTexts()).toEqual(["hello"]);
    f.key("b", { ctrlKey: true });
    expect(f.blockEls()[0]!.innerHTML.toLowerCase()).not.toMatch(/<(strong|b)\b/);
    f.key("Tab");
    expect(f.blockTexts()).toEqual(["hello"]);
  });

  it("editing works again after setEditable(true)", () => {
    f.type("a");
    f.editor.setEditable(false);
    f.press("insertText", "X");
    f.editor.setEditable(true);
    f.type("b");
    expect(f.blockTexts()).toEqual(["ab"]);
  });
});
