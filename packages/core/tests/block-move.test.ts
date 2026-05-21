import { describe, expect, it } from "vitest";
import {
  createEditor,
  getBlock,
  getChildren,
  rootId,
  ROOT_ID,
  connectPeers,
  type BlockId,
} from "../src/index.js";

const seed = (count: number) => {
  const editor = createEditor();
  const root = rootId(editor);
  // The initial seed already has one paragraph; add (count - 1) more so the
  // root has exactly `count` children with stable, document-ordered ids.
  const ids: BlockId[] = [getChildren(editor, root)[0]!];
  for (let i = 1; i < count; i++) {
    const id = editor.commands.block.insert({
      parentId: root,
      index: i,
      kind: "paragraph",
    });
    ids.push(id);
  }
  // Label each block so we can assert order by text.
  ids.forEach((id, i) => {
    editor.commands.text.insert({ blockId: id, offset: 0, value: String(i) });
  });
  return { editor, root, ids };
};

const orderOf = (editor: ReturnType<typeof createEditor>, parent: BlockId) =>
  getChildren(editor, parent).map((id) => editor.commands.text.read(id));

describe("@weaver/core / block.move", () => {
  it("moves a block to a new index within the same parent (forward)", () => {
    const { editor, root, ids } = seed(4);
    // [0,1,2,3] → move index-0 to slot 2 → [1,2,0,3]
    const ok = editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: root,
      newIndex: 2,
    });
    expect(ok).toBe(true);
    expect(orderOf(editor, root)).toEqual(["1", "2", "0", "3"]);
    editor.dispose();
  });

  it("moves a block to a new index within the same parent (backward)", () => {
    const { editor, root, ids } = seed(4);
    const ok = editor.commands.block.move({
      blockId: ids[3]!,
      newParentId: root,
      newIndex: 0,
    });
    expect(ok).toBe(true);
    expect(orderOf(editor, root)).toEqual(["3", "0", "1", "2"]);
    editor.dispose();
  });

  it("moves a block under a new parent at the given index", () => {
    const { editor, root, ids } = seed(3);
    const ok = editor.commands.block.move({
      blockId: ids[2]!,
      newParentId: ids[0]!,
      newIndex: 0,
    });
    expect(ok).toBe(true);
    expect(orderOf(editor, root)).toEqual(["0", "1"]);
    expect(orderOf(editor, ids[0]!)).toEqual(["2"]);
    editor.dispose();
  });

  it("clamps an out-of-range newIndex to the valid maximum", () => {
    const { editor, root, ids } = seed(3);
    const ok = editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: root,
      newIndex: 999,
    });
    expect(ok).toBe(true);
    expect(orderOf(editor, root)).toEqual(["1", "2", "0"]);
    editor.dispose();
  });

  it("clamps a negative newIndex to 0", () => {
    const { editor, root, ids } = seed(3);
    const ok = editor.commands.block.move({
      blockId: ids[2]!,
      newParentId: root,
      newIndex: -5,
    });
    expect(ok).toBe(true);
    expect(orderOf(editor, root)).toEqual(["2", "0", "1"]);
    editor.dispose();
  });

  it("refuses to move a block under itself (would form a cycle)", () => {
    const { editor, ids } = seed(2);
    const ok = editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: ids[0]!,
      newIndex: 0,
    });
    expect(ok).toBe(false);
    editor.dispose();
  });

  it("refuses to move a block under one of its own descendants", () => {
    const { editor, ids } = seed(2);
    // First place ids[1] underneath ids[0] so it becomes a descendant.
    editor.commands.block.move({
      blockId: ids[1]!,
      newParentId: ids[0]!,
      newIndex: 0,
    });
    // Now try to move ids[0] under ids[1] — should refuse.
    const ok = editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: ids[1]!,
      newIndex: 0,
    });
    expect(ok).toBe(false);
    editor.dispose();
  });

  it("returns false when the block id is unknown", () => {
    const editor = createEditor();
    const ok = editor.commands.block.move({
      blockId: "no-such-block",
      newParentId: ROOT_ID,
      newIndex: 0,
    });
    expect(ok).toBe(false);
    editor.dispose();
  });

  it("returns false when the new parent id is unknown", () => {
    const { editor, ids } = seed(2);
    const ok = editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: "no-such-parent",
      newIndex: 0,
    });
    expect(ok).toBe(false);
    editor.dispose();
  });

  it("preserves the moved block's children and inline text", () => {
    const { editor, ids } = seed(2);
    // Add a child to ids[0]; we want to verify it travels with the move.
    const childId = editor.commands.block.insert({
      parentId: ids[0]!,
      index: 0,
      kind: "paragraph",
    });
    editor.commands.text.insert({
      blockId: childId,
      offset: 0,
      value: "child",
    });
    editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: ids[1]!,
      newIndex: 0,
    });
    expect(orderOf(editor, ids[1]!)).toEqual(["0"]);
    expect(orderOf(editor, ids[0]!)).toEqual(["child"]);
    editor.dispose();
  });

  it("creates an undoable step that restores the prior order", () => {
    const { editor, root, ids } = seed(3);
    editor.commands.history.flushMergeWindow();
    editor.commands.block.move({
      blockId: ids[0]!,
      newParentId: root,
      newIndex: 2,
    });
    expect(orderOf(editor, root)).toEqual(["1", "2", "0"]);
    expect(editor.commands.history.canUndo()).toBe(true);
    editor.commands.history.undo();
    expect(orderOf(editor, root)).toEqual(["0", "1", "2"]);
    editor.dispose();
  });

  it("converges across peers when two peers move the same block to different parents", async () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "user" });
    const link = connectPeers(a, b);
    const root = rootId(a);
    // Seed three blocks (one is the implicit seed; add two more on `a`, sync).
    a.commands.block.insert({ parentId: root, index: 1, kind: "paragraph" });
    a.commands.block.insert({ parentId: root, index: 2, kind: "paragraph" });
    await Promise.resolve();
    const aIds = getChildren(a, root);
    const bIds = getChildren(b, root);
    expect(bIds).toEqual(aIds);
    // Both peers move aIds[2] — `a` to slot 0, `b` to slot 1.
    a.commands.block.move({
      blockId: aIds[2]!,
      newParentId: root,
      newIndex: 0,
    });
    b.commands.block.move({
      blockId: bIds[2]!,
      newParentId: root,
      newIndex: 1,
    });
    await Promise.resolve();
    // CRDT convergence: both peers see the same final order. The exact
    // arrangement is determined by Loro's move semantics — we only assert
    // mutual agreement and that the moved block still exists exactly once.
    const aOrder = getChildren(a, root);
    const bOrder = getChildren(b, root);
    expect(aOrder).toEqual(bOrder);
    expect(aOrder.filter((x) => x === aIds[2]!).length).toBe(1);
    link.dispose();
    a.dispose();
    b.dispose();
  });

  it("does not bleed the moved subtree's identity (block id stays stable)", () => {
    const { editor, root, ids } = seed(3);
    const before = getBlock(editor, ids[1]!);
    editor.commands.block.move({
      blockId: ids[1]!,
      newParentId: ids[0]!,
      newIndex: 0,
    });
    const after = getBlock(editor, ids[1]!);
    expect(after?.id).toBe(before?.id);
    expect(after?.kind).toBe(before?.kind);
    expect(editor.commands.text.read(ids[1]!)).toBe("1");
    editor.dispose();
  });
});
