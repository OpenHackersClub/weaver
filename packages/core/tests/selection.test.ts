import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "../src/index.js";
import { future, type FutureSelectionRange } from "./_test-helpers.js";

/**
 * Selection tests — TDD red.
 *
 * specs/lexical-parity.md §3 commits to `selection.*` commands and §5 to
 * `useSelection()`. Today the editor has no selection surface — these tests
 * pin the contract.
 */

const setup = () => {
  const editor = createEditor();
  const root = rootId(editor);
  const firstId = getChildren(editor, root)[0]!;
  editor.commands.text.insert({
    blockId: firstId,
    offset: 0,
    value: "abcdefghij",
  });
  const secondId = editor.commands.block.insert({
    parentId: root,
    index: 1,
    kind: "paragraph",
    attrs: {},
  });
  editor.commands.text.insert({
    blockId: secondId,
    offset: 0,
    value: "0123456789",
  });
  return { editor, firstId, secondId };
};

describe("@weaver/core / selection — collapsed (single caret)", () => {
  it("collapse(blockId, offset) puts the caret at that position", () => {
    const { editor, firstId } = setup();
    future(editor).commands.selection.collapse(firstId, 5);
    const sel = future(editor).commands.selection.get();
    const expected: FutureSelectionRange = {
      anchor: { blockId: firstId, offset: 5 },
      focus: { blockId: firstId, offset: 5 },
    };
    expect(sel).toEqual(expected);
    editor.dispose();
  });

  it("get() returns null when no selection has been set", () => {
    const { editor } = setup();
    expect(future(editor).commands.selection.get()).toBeNull();
    editor.dispose();
  });

  it("collapse clamps the offset to the block's text length", () => {
    const { editor, firstId } = setup();
    future(editor).commands.selection.collapse(firstId, 999);
    const sel = future(editor).commands.selection.get();
    expect(sel?.focus.offset).toBe(10);
    editor.dispose();
  });
});

describe("@weaver/core / selection — non-collapsed range", () => {
  it("set with anchor === focus is treated as collapsed", () => {
    const { editor, firstId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: firstId, offset: 2 },
    });
    expect(future(editor).commands.selection.get()).toEqual({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: firstId, offset: 2 },
    });
    editor.dispose();
  });

  it("set spans two blocks with anchor and focus on different blocks", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: secondId, offset: 4 },
    });
    expect(future(editor).commands.selection.get()).toEqual({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: secondId, offset: 4 },
    });
    editor.dispose();
  });

  it("set is allowed with focus before anchor (backward selection)", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: secondId, offset: 4 },
      focus: { blockId: firstId, offset: 2 },
    });
    const sel = future(editor).commands.selection.get();
    expect(sel?.anchor.blockId).toBe(secondId);
    expect(sel?.focus.blockId).toBe(firstId);
    editor.dispose();
  });
});

describe("@weaver/core / selection — derived data", () => {
  it("getTextContent returns the in-range text for a single-block selection", () => {
    const { editor, firstId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: firstId, offset: 7 },
    });
    expect(future(editor).commands.selection.getTextContent()).toBe("cdefg");
    editor.dispose();
  });

  it("getTextContent for a multi-block selection joins blocks with a newline", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 8 },
      focus: { blockId: secondId, offset: 3 },
    });
    expect(future(editor).commands.selection.getTextContent()).toBe("ij\n012");
    editor.dispose();
  });

  it("getBlockIds returns every block touched by the range, in document order", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: secondId, offset: 4 },
    });
    expect(future(editor).commands.selection.getBlockIds()).toEqual([
      firstId,
      secondId,
    ]);
    editor.dispose();
  });
});

describe("@weaver/core / selection — mutating commands", () => {
  it("selectAll spans from the start of the first block to the end of the last", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.selectAll();
    const sel = future(editor).commands.selection.get();
    expect(sel?.anchor).toEqual({ blockId: firstId, offset: 0 });
    expect(sel?.focus).toEqual({ blockId: secondId, offset: 10 });
    editor.dispose();
  });

  it("insertText on a single-block range replaces the range with the value", () => {
    const { editor, firstId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 2 },
      focus: { blockId: firstId, offset: 5 },
    });
    future(editor).commands.selection.insertText("XYZ");
    expect(editor.commands.text.read(firstId)).toBe("abXYZfghij");
    editor.dispose();
  });

  it("insertText on a multi-block range merges the touched blocks into the anchor", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 5 },
      focus: { blockId: secondId, offset: 3 },
    });
    future(editor).commands.selection.insertText("|");
    expect(editor.commands.text.read(firstId)).toBe("abcde|3456789");
    expect(getChildren(editor, rootId(editor))).toHaveLength(1);
    editor.dispose();
  });

  it("deleteRange on a multi-block range merges the touched blocks", () => {
    const { editor, firstId, secondId } = setup();
    future(editor).commands.selection.set({
      anchor: { blockId: firstId, offset: 5 },
      focus: { blockId: secondId, offset: 3 },
    });
    future(editor).commands.selection.deleteRange();
    expect(editor.commands.text.read(firstId)).toBe("abcde3456789");
    expect(getChildren(editor, rootId(editor))).toHaveLength(1);
    editor.dispose();
  });
});
