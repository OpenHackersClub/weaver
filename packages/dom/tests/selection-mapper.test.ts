import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId, type Editor } from "@weaver/core";
import { reconcileTopLevel } from "../src/dom-mapper.js";
import {
  placeCaret,
  readDomSelection,
  writeDomSelection,
} from "../src/selection-mapper.js";

let host: HTMLElement;
let editor: Editor;

beforeEach(() => {
  editor = createEditor();
  host = document.createElement("div");
  document.body.appendChild(host);
  const id = getChildren(editor, rootId(editor))[0]!;
  editor.commands.text.insert({ blockId: id, offset: 0, value: "alphabet" });
  reconcileTopLevel(editor, host);
});
afterEach(() => {
  host.remove();
  editor.dispose();
});

describe("@weaver/dom / readDomSelection", () => {
  it("returns null when there is no selection inside the host", () => {
    document.getSelection()?.removeAllRanges();
    expect(readDomSelection(host)).toBeNull();
  });

  it("returns a DomRange when the selection lives inside a block element", () => {
    const block = host.querySelector("[data-block-id]") as HTMLElement;
    const text = block.firstChild as Text;
    const r = document.createRange();
    r.setStart(text, 2);
    r.setEnd(text, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);

    const range = readDomSelection(host);
    expect(range).not.toBeNull();
    expect(range!.anchor.offset).toBe(2);
    expect(range!.focus.offset).toBe(5);
    expect(range!.collapsed).toBe(false);
  });

  it("returns null when the anchor is outside the host", () => {
    const outside = document.createElement("span");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    const r = document.createRange();
    r.setStart(outside.firstChild!, 0);
    r.setEnd(outside.firstChild!, 0);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    expect(readDomSelection(host)).toBeNull();
    outside.remove();
  });
});

describe("@weaver/dom / writeDomSelection & placeCaret", () => {
  it("placeCaret positions the live DOM selection at the requested offset", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    placeCaret(host, { blockId: id, offset: 4 });
    const sel = document.getSelection()!;
    expect(sel.anchorOffset).toBe(4);
    expect(sel.focusOffset).toBe(4);
  });

  it("writeDomSelection accepts a multi-block range", () => {
    // Add a second block, type into it, then assert a cross-block range
    // writes back without throwing.
    const root = rootId(editor);
    const second = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: second, offset: 0, value: "world" });
    reconcileTopLevel(editor, host);

    const first = getChildren(editor, root)[0]!;
    expect(() =>
      writeDomSelection(host, {
        anchor: { blockId: first, offset: 2 },
        focus: { blockId: second, offset: 3 },
        collapsed: false,
      }),
    ).not.toThrow();

    const sel = document.getSelection()!;
    expect(sel.toString()).toContain("phabet");
    expect(sel.toString()).toContain("wor");
  });
});

describe("@weaver/dom / selection — read after edit", () => {
  it("after a text.insert + reconcile, readDomSelection still reads a valid range", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    placeCaret(host, { blockId: id, offset: 3 });
    editor.commands.text.insert({ blockId: id, offset: 3, value: "X" });
    reconcileTopLevel(editor, host);
    placeCaret(host, { blockId: id, offset: 4 });
    const range = readDomSelection(host);
    expect(range?.anchor.offset).toBe(4);
  });
});
