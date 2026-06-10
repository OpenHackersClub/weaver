import { describe, expect, it } from "vitest";
import { createEditor, getBlock, getChildren, rootId } from "../src/index.js";
import { future } from "./_test-helpers.js";

/**
 * History tests.
 *
 * `@weaver/core` exposes Loro's `UndoManager` (peer-scoped,
 * mergeInterval-aware) through `commands.history`. These tests pin the
 * contract from specs/lexical-parity.md §3 (UNDO_COMMAND, REDO_COMMAND,
 * CLEAR_HISTORY_COMMAND, CAN_UNDO / CAN_REDO) and ADR 0001 (peer-scoped undo).
 */

const seedParagraph = () => {
  const editor = createEditor();
  const root = rootId(editor);
  const id = getChildren(editor, root)[0]!;
  return { editor, root, id };
};

describe("@weaver/core / history — undo/redo of text edits", () => {
  it("undo reverts a single text.insert", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    expect(editor.commands.text.read(id)).toBe("hello");
    const ok = future(editor).commands.history.undo();
    expect(ok).toBe(true);
    expect(editor.commands.text.read(id)).toBe("");
    editor.dispose();
  });

  it("redo re-applies the undone insert", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    future(editor).commands.history.undo();
    const ok = future(editor).commands.history.redo();
    expect(ok).toBe(true);
    expect(editor.commands.text.read(id)).toBe("hello");
    editor.dispose();
  });

  it("undo of multiple inserts unwinds them one step at a time", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "alpha" });
    // Close the merge window so "beta" lands on a fresh undo step rather than
    // being coalesced with "alpha" (Loro merges within `mergeInterval`).
    future(editor).commands.history.flushMergeWindow();
    editor.commands.text.insert({ blockId: id, offset: 5, value: "beta" });
    future(editor).commands.history.undo();
    expect(editor.commands.text.read(id)).toBe("alpha");
    editor.dispose();
  });
});

describe("@weaver/core / history — undo/redo of structural ops", () => {
  it("undo reverts a block.insert", () => {
    const { editor, root } = seedParagraph();
    const before = getChildren(editor, root).length;
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    future(editor).commands.history.undo();
    expect(getChildren(editor, root)).toHaveLength(before);
    editor.dispose();
  });

  it("undo reverts a block.transform back to the prior kind & attrs", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "Title" });
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    expect(getBlock(editor, id)?.kind).toBe("heading");
    future(editor).commands.history.undo();
    expect(getBlock(editor, id)?.kind).toBe("paragraph");
    expect(editor.commands.text.read(id)).toBe("Title");
    editor.dispose();
  });

  it("undo reverts a block.split", () => {
    const { editor, id, root } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "alphabet" });
    editor.commands.block.split({ blockId: id, offset: 5 });
    expect(getChildren(editor, root)).toHaveLength(2);
    future(editor).commands.history.undo();
    expect(getChildren(editor, root)).toHaveLength(1);
    expect(editor.commands.text.read(id)).toBe("alphabet");
    editor.dispose();
  });

  it("undo reverts a block.merge, restoring both blocks and their texts", () => {
    const { editor, root, id: firstId } = seedParagraph();
    editor.commands.text.insert({ blockId: firstId, offset: 0, value: "alpha" });
    const secondId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: "bet" });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    future(editor).commands.history.undo();
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(2);
    expect(editor.commands.text.read(kids[0]!)).toBe("alpha");
    expect(editor.commands.text.read(kids[1]!)).toBe("bet");
    editor.dispose();
  });

  it("undo reverts a mark toggle", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    future(editor).commands.history.undo();
    const delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([{ insert: "hello" }]);
    editor.dispose();
  });
});

describe("@weaver/core / history — stack introspection & clear", () => {
  it("canUndo is false on a fresh editor", () => {
    const { editor } = seedParagraph();
    expect(future(editor).commands.history.canUndo()).toBe(false);
    editor.dispose();
  });

  it("canUndo flips true after the first edit", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    expect(future(editor).commands.history.canUndo()).toBe(true);
    editor.dispose();
  });

  it("canRedo flips true only after an undo", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    expect(future(editor).commands.history.canRedo()).toBe(false);
    future(editor).commands.history.undo();
    expect(future(editor).commands.history.canRedo()).toBe(true);
    editor.dispose();
  });

  it("a new edit after an undo clears the redo stack", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "a" });
    future(editor).commands.history.undo();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "b" });
    expect(future(editor).commands.history.canRedo()).toBe(false);
    editor.dispose();
  });

  it("clearHistory empties both stacks without modifying the document", () => {
    const { editor, id } = seedParagraph();
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    const before = editor.commands.text.read(id);
    future(editor).commands.history.clearHistory();
    expect(future(editor).commands.history.canUndo()).toBe(false);
    expect(future(editor).commands.history.canRedo()).toBe(false);
    expect(editor.commands.text.read(id)).toBe(before);
    editor.dispose();
  });

  it("undo returns false on an empty stack", () => {
    const { editor } = seedParagraph();
    expect(future(editor).commands.history.undo()).toBe(false);
    editor.dispose();
  });
});

describe("@weaver/core / history — peer scoping by origin (ADR 0001)", () => {
  it("undo on a 'user' editor does not roll back changes from an 'agent' peer", () => {
    // Two LoroDocs synced via export/import — each has its own UndoManager.
    // Undo on user should affect only ops that originated on user.
    const userEditor = createEditor({ origin: "user" });
    const agentEditor = createEditor({ origin: "agent", seed: false });

    // sync agent ← user initial state
    agentEditor.doc.import(userEditor.doc.export({ mode: "update" }));

    const userRoot = rootId(userEditor);
    const userBlockId = getChildren(userEditor, userRoot)[0]!;
    userEditor.commands.text.insert({
      blockId: userBlockId,
      offset: 0,
      value: "by-user",
    });

    // sync agent ← user edit
    agentEditor.doc.import(userEditor.doc.export({ mode: "update" }));
    const agentBlockId = getChildren(agentEditor, rootId(agentEditor))[0]!;
    agentEditor.commands.text.insert({
      blockId: agentBlockId,
      offset: "by-user".length,
      value: "-by-agent",
    });

    // sync user ← agent edit
    userEditor.doc.import(agentEditor.doc.export({ mode: "update" }));
    expect(userEditor.commands.text.read(userBlockId)).toBe("by-user-by-agent");

    // User's undo should remove "by-user", leaving "-by-agent".
    future(userEditor).commands.history.undo();
    expect(userEditor.commands.text.read(userBlockId)).toBe("-by-agent");

    userEditor.dispose();
    agentEditor.dispose();
  });
});
