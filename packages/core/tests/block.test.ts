import { describe, expect, it } from "vitest";
import {
  createEditor,
  getBlock,
  getChildren,
  rootId,
  type BlockKind,
} from "../src/index.js";

const setup = () => createEditor();

describe("@weaver/core / block commands", () => {
  it("createEditor seeds one empty paragraph under root", () => {
    const editor = setup();
    const kids = getChildren(editor, rootId(editor));
    expect(kids).toHaveLength(1);
    const first = getBlock(editor, kids[0]!);
    expect(first?.kind).toBe<BlockKind>("paragraph");
    expect(first?.hasInline).toBe(true);
    editor.dispose();
  });

  it("block.insert appends a typed block at index", () => {
    const editor = setup();
    const root = rootId(editor);
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(2);
    const h = getBlock(editor, kids[1]!);
    expect(h?.kind).toBe<BlockKind>("heading");
    expect(h?.attrs).toMatchObject({ level: 2 });
    editor.dispose();
  });

  it("block.split splits a text-bearing block at offset into two siblings", () => {
    const editor = setup();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    editor.commands.text.insert({ blockId: firstId, offset: 0, value: "alphabet" });
    editor.commands.block.split({ blockId: firstId, offset: 5 });
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(2);
    expect(editor.commands.text.read(kids[0]!)).toBe("alpha");
    expect(editor.commands.text.read(kids[1]!)).toBe("bet");
    editor.dispose();
  });

  it("block.merge concatenates next block's text into prev and deletes next", () => {
    const editor = setup();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    editor.commands.text.insert({ blockId: firstId, offset: 0, value: "first" });
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    const secondId = getChildren(editor, root)[1]!;
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: "second" });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(1);
    expect(editor.commands.text.read(kids[0]!)).toBe("firstsecond");
    editor.dispose();
  });

  it("block.transform changes the kind in place and preserves text", () => {
    const editor = setup();
    const root = rootId(editor);
    const id = getChildren(editor, root)[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "Title" });
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    const b = getBlock(editor, id);
    expect(b?.kind).toBe<BlockKind>("heading");
    expect(b?.attrs).toMatchObject({ level: 1 });
    expect(editor.commands.text.read(id)).toBe("Title");
    editor.dispose();
  });

  it("block.delete removes the node from the tree", () => {
    const editor = setup();
    const root = rootId(editor);
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    const second = getChildren(editor, root)[1]!;
    editor.commands.block.delete({ blockId: second });
    expect(getChildren(editor, root)).toHaveLength(1);
    editor.dispose();
  });

  it("each command runs in a single doc.commit and carries the configured origin", () => {
    const editor = setup();
    const root = rootId(editor);
    const seen: string[] = [];
    const unsub = editor.doc.subscribe((batch) => {
      seen.push(batch.origin ?? "");
    });
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 3 },
    });
    unsub();
    expect(seen).toContain("user");
    editor.dispose();
  });
});

describe("@weaver/core / marks", () => {
  it("text.toggleMark applies and removes a bold mark over a range", () => {
    const editor = setup();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    let delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([{ insert: "hello", attributes: { bold: true } }]);

    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([{ insert: "hello" }]);
    editor.dispose();
  });
});
