import { describe, expect, it } from "vitest";
import { createEditor, getBlock, getChildren, rootId } from "../src/index.js";

const setup = () => {
  const editor = createEditor();
  const root = rootId(editor);
  const id = getChildren(editor, root)[0]!;
  return { editor, root, id };
};

describe("@weaver/core / block.setAttr", () => {
  it("sets a single attribute on a block, merging with existing attrs", () => {
    const { editor, id } = setup();
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    editor.commands.block.setAttr({
      blockId: id,
      key: "align",
      value: "center",
    });
    const b = getBlock(editor, id);
    expect(b?.attrs).toMatchObject({ level: 2, align: "center" });
  });

  it("overwrites an existing attribute key without dropping siblings", () => {
    const { editor, id } = setup();
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    editor.commands.block.setAttr({ blockId: id, key: "level", value: 3 });
    editor.commands.block.setAttr({
      blockId: id,
      key: "align",
      value: "right",
    });
    editor.commands.block.setAttr({ blockId: id, key: "level", value: 4 });
    const b = getBlock(editor, id);
    expect(b?.attrs).toEqual({ level: 4, align: "right" });
  });

  it("supports nullable / removable-style values by writing null", () => {
    const { editor, id } = setup();
    editor.commands.block.setAttr({
      blockId: id,
      key: "align",
      value: "left",
    });
    editor.commands.block.setAttr({ blockId: id, key: "align", value: null });
    const b = getBlock(editor, id);
    expect(b?.attrs).toMatchObject({ align: null });
  });

  it("is a no-op for an unknown block id", () => {
    const { editor } = setup();
    // No throw; nothing to assert beyond non-throwing behavior.
    expect(() =>
      editor.commands.block.setAttr({
        blockId: "no-such",
        key: "align",
        value: "center",
      }),
    ).not.toThrow();
  });

  it("emits a commit under the editor's origin", () => {
    const { editor, id } = setup();
    const seen: string[] = [];
    const unsub = editor.doc.subscribe((batch) => {
      seen.push(batch.origin ?? "");
    });
    editor.commands.block.setAttr({
      blockId: id,
      key: "align",
      value: "center",
    });
    unsub();
    expect(seen).toContain("user");
  });

  it("creates an undoable step (canUndo + undo restores prior attrs)", () => {
    const { editor, id } = setup();
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    editor.commands.history.flushMergeWindow();
    editor.commands.block.setAttr({ blockId: id, key: "level", value: 3 });
    expect(getBlock(editor, id)?.attrs).toMatchObject({ level: 3 });
    expect(editor.commands.history.canUndo()).toBe(true);
    editor.commands.history.undo();
    expect(getBlock(editor, id)?.attrs).toMatchObject({ level: 1 });
  });

  it("accepts object values (e.g. a structured caption)", () => {
    const { editor, id } = setup();
    editor.commands.block.setAttr({
      blockId: id,
      key: "meta",
      value: { author: "alice", priority: 2 },
    });
    const b = getBlock(editor, id);
    expect(b?.attrs).toMatchObject({
      meta: { author: "alice", priority: 2 },
    });
  });
});
