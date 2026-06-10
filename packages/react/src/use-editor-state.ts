import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Editor, SelectionRange } from "@weaver/core";

/**
 * React bindings for editor state living outside the LoroDoc — selection,
 * undo-stack introspection, editable flag (specs/lexical-parity.md §5).
 * Each hook subscribes through the editor's change-notification surface via
 * `useSyncExternalStore`; snapshots are reference-stable between changes so
 * components only re-render on real transitions.
 */

/**
 * The current selection as typed `SelectionRange` anchors, or `null` when no
 * selection exists. weaver's analog of Lexical's `$getSelection` +
 * `SELECTION_CHANGE_COMMAND` subscription.
 */
export const useSelection = (editor: Editor): SelectionRange | null =>
  useSyncExternalStore(
    useCallback((onChange) => editor.onSelectionChange(onChange), [editor]),
    () => editor.commands.selection.get(),
    () => editor.commands.selection.get(),
  );

export interface UndoState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/**
 * Live `canUndo` / `canRedo` flags — weaver's analog of Lexical's
 * `CAN_UNDO_COMMAND` / `CAN_REDO_COMMAND` introspection. New undoable steps
 * arrive via doc commits (`doc.subscribe`); undo/redo/clearHistory notify
 * through `onHistoryChange` (clearHistory never commits, so doc subscription
 * alone would miss it).
 */
export const useUndoState = (editor: Editor): UndoState => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubDoc = editor.doc.subscribe(() => onChange());
      const unsubHistory = editor.onHistoryChange(onChange);
      return () => {
        unsubDoc();
        unsubHistory();
      };
    },
    [editor],
  );
  // One store, one subscription (two stores would register doc + history
  // listeners twice per mount). The snapshot object is cached and reused
  // while both flags are unchanged — useSyncExternalStore needs a stable
  // reference or it re-renders on every check.
  const cache = useRef<UndoState>({ canUndo: false, canRedo: false });
  const getSnapshot = useCallback((): UndoState => {
    const canUndo = editor.commands.history.canUndo();
    const canRedo = editor.commands.history.canRedo();
    const prev = cache.current;
    if (prev.canUndo !== canUndo || prev.canRedo !== canRedo) {
      cache.current = { canUndo, canRedo };
    }
    return cache.current;
  }, [editor]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** Whether the editor accepts edits — Lexical's `useLexicalEditable`. */
export const useEditable = (editor: Editor): boolean =>
  useSyncExternalStore(
    useCallback((onChange) => editor.onEditableChange(onChange), [editor]),
    () => editor.isEditable(),
    () => editor.isEditable(),
  );
