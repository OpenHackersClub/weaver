import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "@weaver/core";
import { useEditable, useSelection, useUndoState } from "../src/index.js";

/**
 * React parity hooks — specs/lexical-parity.md §5:
 * - `useSelection()` ↔ Lexical's `$getSelection` / SELECTION_CHANGE_COMMAND
 * - `useUndoState()` ↔ CAN_UNDO_COMMAND / CAN_REDO_COMMAND introspection
 * - `useEditable()` ↔ Lexical's `useLexicalEditable`
 *
 * The hooks subscribe through the core editor's change-notification surface
 * (`onSelectionChange` / `onHistoryChange` / `onEditableChange`) via
 * `useSyncExternalStore`, so they re-render only on actual state changes.
 */

const seededEditor = (value = "hello") => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  if (value) editor.commands.text.insert({ blockId: id, offset: 0, value });
  return { editor, id };
};

describe("@weaver/react / useSelection", () => {
  it("returns null before any selection exists", () => {
    const { editor } = seededEditor();
    const { result, unmount } = renderHook(() => useSelection(editor));
    expect(result.current).toBeNull();
    unmount();
    editor.dispose();
  });

  it("updates when the selection changes", () => {
    const { editor, id } = seededEditor();
    const { result, unmount } = renderHook(() => useSelection(editor));
    act(() => {
      editor.commands.selection.collapse(id, 2);
    });
    expect(result.current).toEqual({
      anchor: { blockId: id, offset: 2 },
      focus: { blockId: id, offset: 2 },
    });
    act(() => {
      editor.commands.selection.selectAll();
    });
    expect(result.current).toEqual({
      anchor: { blockId: id, offset: 0 },
      focus: { blockId: id, offset: 5 },
    });
    unmount();
    editor.dispose();
  });

  it("tracks caret movement from range mutations", () => {
    const { editor, id } = seededEditor();
    const { result, unmount } = renderHook(() => useSelection(editor));
    act(() => {
      editor.commands.selection.set({
        anchor: { blockId: id, offset: 0 },
        focus: { blockId: id, offset: 5 },
      });
      editor.commands.selection.insertText("bye");
    });
    expect(result.current).toEqual({
      anchor: { blockId: id, offset: 3 },
      focus: { blockId: id, offset: 3 },
    });
    unmount();
    editor.dispose();
  });
});

describe("@weaver/react / useUndoState", () => {
  it("reflects canUndo / canRedo through edit, undo, redo", () => {
    const { editor, id } = seededEditor("");
    const { result, unmount } = renderHook(() => useUndoState(editor));
    expect(result.current).toEqual({ canUndo: false, canRedo: false });

    act(() => {
      editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    });
    expect(result.current).toEqual({ canUndo: true, canRedo: false });

    act(() => {
      editor.commands.history.undo();
    });
    expect(result.current).toEqual({ canUndo: false, canRedo: true });

    act(() => {
      editor.commands.history.redo();
    });
    expect(result.current).toEqual({ canUndo: true, canRedo: false });
    unmount();
    editor.dispose();
  });

  it("resets after clearHistory", () => {
    const { editor, id } = seededEditor("");
    const { result, unmount } = renderHook(() => useUndoState(editor));
    act(() => {
      editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    });
    expect(result.current.canUndo).toBe(true);
    act(() => {
      editor.commands.history.clearHistory();
    });
    expect(result.current).toEqual({ canUndo: false, canRedo: false });
    unmount();
    editor.dispose();
  });
});

describe("@weaver/react / useEditable", () => {
  it("mirrors setEditable toggles", () => {
    const { editor } = seededEditor();
    const { result, unmount } = renderHook(() => useEditable(editor));
    expect(result.current).toBe(true);
    act(() => {
      editor.setEditable(false);
    });
    expect(result.current).toBe(false);
    act(() => {
      editor.setEditable(true);
    });
    expect(result.current).toBe(true);
    unmount();
    editor.dispose();
  });
});

describe("@weaver/react / useSelection after undo", () => {
  it("does not go stale when undo removes the selected block", () => {
    const { editor } = seededEditor("a");
    const root = rootId(editor);
    editor.commands.history.flushMergeWindow();
    const second = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
    });
    const { result, unmount } = renderHook(() => useSelection(editor));
    act(() => {
      editor.commands.selection.collapse(second, 0);
    });
    expect(result.current?.anchor.blockId).toBe(second);
    act(() => {
      editor.commands.history.undo(); // removes `second`
    });
    expect(result.current).toBeNull();
    unmount();
    editor.dispose();
  });
});
