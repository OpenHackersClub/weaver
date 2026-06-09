import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "../src/index.js";

/**
 * Editor change-notification surface — the core half of the React hooks rows
 * in specs/lexical-parity.md §5 (`useSelection`, `useUndoState`,
 * `useEditable`) and §3 (`SELECTION_CHANGE_COMMAND` notification).
 *
 * `currentSelection` and `editable` are in-memory editor state, not LoroDoc
 * containers (see CLAUDE.md state-layering table), so `doc.subscribe` can't
 * observe them. These listener registries close that gap; React reaches them
 * through `useSyncExternalStore`.
 */

describe("@weaver/core / onSelectionChange", () => {
  it("notifies when the selection is set, collapsed, or select-all'd", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    let calls = 0;
    const unsub = editor.onSelectionChange(() => {
      calls += 1;
    });
    editor.commands.selection.collapse(id, 1);
    expect(calls).toBe(1);
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 0 },
      focus: { blockId: id, offset: 5 },
    });
    expect(calls).toBe(2);
    editor.commands.selection.selectAll();
    expect(calls).toBe(3);
    unsub();
    editor.dispose();
  });

  it("notifies when a range mutation moves the caret", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 0 },
      focus: { blockId: id, offset: 5 },
    });
    let calls = 0;
    const unsub = editor.onSelectionChange(() => {
      calls += 1;
    });
    editor.commands.selection.insertText("bye");
    expect(calls).toBe(1);
    expect(editor.commands.selection.get()).toEqual({
      anchor: { blockId: id, offset: 3 },
      focus: { blockId: id, offset: 3 },
    });
    unsub();
    editor.dispose();
  });

  it("notifies when editor.clear() drops the selection", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.selection.collapse(id, 0);
    let calls = 0;
    editor.onSelectionChange(() => {
      calls += 1;
    });
    editor.clear();
    expect(calls).toBe(1);
    expect(editor.commands.selection.get()).toBeNull();
    editor.dispose();
  });

  it("stops notifying after unsubscribe", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    let calls = 0;
    const unsub = editor.onSelectionChange(() => {
      calls += 1;
    });
    editor.commands.selection.collapse(id, 0);
    unsub();
    editor.commands.selection.collapse(id, 0);
    expect(calls).toBe(1);
    editor.dispose();
  });
});

describe("@weaver/core / onEditableChange", () => {
  it("notifies on setEditable transitions with the new value readable", () => {
    const editor = createEditor();
    const seen: boolean[] = [];
    const unsub = editor.onEditableChange(() => {
      seen.push(editor.isEditable());
    });
    editor.setEditable(false);
    editor.setEditable(true);
    expect(seen).toEqual([false, true]);
    unsub();
    editor.dispose();
  });

  it("does not notify when the value is unchanged", () => {
    const editor = createEditor();
    let calls = 0;
    editor.onEditableChange(() => {
      calls += 1;
    });
    editor.setEditable(true); // already true
    expect(calls).toBe(0);
    editor.dispose();
  });
});

describe("@weaver/core / onHistoryChange", () => {
  it("notifies when clearHistory drops the undo stack", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    expect(editor.commands.history.canUndo()).toBe(true);
    let calls = 0;
    editor.onHistoryChange(() => {
      calls += 1;
    });
    editor.commands.history.clearHistory();
    expect(calls).toBe(1);
    expect(editor.commands.history.canUndo()).toBe(false);
    editor.dispose();
  });

  it("notifies on undo and redo", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    let calls = 0;
    editor.onHistoryChange(() => {
      calls += 1;
    });
    editor.commands.history.undo();
    expect(calls).toBe(1);
    editor.commands.history.redo();
    expect(calls).toBe(2);
    editor.dispose();
  });
});
