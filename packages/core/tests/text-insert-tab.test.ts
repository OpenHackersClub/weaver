import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "../src/index.js";

const setup = () => {
  const editor = createEditor();
  const root = rootId(editor);
  const id = getChildren(editor, root)[0]!;
  return { editor, root, id };
};

describe("@weaver/core / text.insertTab", () => {
  it("inserts a literal tab character at the offset", () => {
    const { editor, id } = setup();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "before" });
    editor.commands.text.insertTab({ blockId: id, offset: 6 });
    editor.commands.text.insert({ blockId: id, offset: 7, value: "after" });
    expect(editor.commands.text.read(id)).toBe("before\tafter");
  });

  it("clamps a negative offset to 0", () => {
    const { editor, id } = setup();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "abc" });
    editor.commands.text.insertTab({ blockId: id, offset: -10 });
    expect(editor.commands.text.read(id)).toBe("\tabc");
  });

  it("clamps an over-large offset to the end", () => {
    const { editor, id } = setup();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "abc" });
    editor.commands.text.insertTab({ blockId: id, offset: 999 });
    expect(editor.commands.text.read(id)).toBe("abc\t");
  });

  it("works on an empty block", () => {
    const { editor, id } = setup();
    editor.commands.text.insertTab({ blockId: id, offset: 0 });
    expect(editor.commands.text.read(id)).toBe("\t");
  });

  it("rejects insertion on a divider (no inline text)", () => {
    const { editor, root } = setup();
    const dividerId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "divider",
    });
    expect(() =>
      editor.commands.text.insertTab({ blockId: dividerId, offset: 0 }),
    ).toThrow();
  });

  it("rejects insertion on a missing block", () => {
    const { editor } = setup();
    expect(() =>
      editor.commands.text.insertTab({ blockId: "no-such", offset: 0 }),
    ).toThrow();
  });

  it("inserts a tab inside a code block", () => {
    const { editor, root } = setup();
    const codeId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "code",
    });
    editor.commands.text.insert({ blockId: codeId, offset: 0, value: "fn x" });
    editor.commands.text.insertTab({ blockId: codeId, offset: 0 });
    expect(editor.commands.text.read(codeId)).toBe("\tfn x");
  });

  it("is undoable (single step, restores prior text)", () => {
    const { editor, id } = setup();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "abc" });
    editor.commands.history.flushMergeWindow();
    editor.commands.text.insertTab({ blockId: id, offset: 1 });
    expect(editor.commands.text.read(id)).toBe("a\tbc");
    editor.commands.history.undo();
    expect(editor.commands.text.read(id)).toBe("abc");
  });

  it("inserts tab as a single character (length grows by 1)", () => {
    const { editor, id } = setup();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "xy" });
    const before = editor.commands.text.length(id);
    editor.commands.text.insertTab({ blockId: id, offset: 1 });
    expect(editor.commands.text.length(id)).toBe(before + 1);
  });
});
