import { useCallback, useSyncExternalStore } from "react";
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
  const canUndo = useSyncExternalStore(
    subscribe,
    () => editor.commands.history.canUndo(),
    () => editor.commands.history.canUndo(),
  );
  const canRedo = useSyncExternalStore(
    subscribe,
    () => editor.commands.history.canRedo(),
    () => editor.commands.history.canRedo(),
  );
  return { canUndo, canRedo };
};

/** Whether the editor accepts edits — Lexical's `useLexicalEditable`. */
export const useEditable = (editor: Editor): boolean =>
  useSyncExternalStore(
    useCallback((onChange) => editor.onEditableChange(onChange), [editor]),
    () => editor.isEditable(),
    () => editor.isEditable(),
  );
