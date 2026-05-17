/**
 * Shared test scaffolding for `@weaver/core`.
 *
 * The `Future*` types name the command-bus surface our specs commit to but
 * which is **not yet implemented** in `editor.ts`. Tests cast `editor.commands`
 * to the matching future shape so they compile cleanly today, fail at runtime
 * with a clear "X is not a function", and turn green when the implementor
 * fills in the API. The shape doubles as a TypeScript-checked spec for the
 * future surface.
 *
 * See `specs/lexical-parity.md` §3 for the command-bus contract these mirror.
 */
import type { BlockId, Editor, EditorCommands, MarkKind } from "../src/index.js";

export interface FutureHistoryCommands {
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clearHistory(): void;
  /**
   * Close the current undo-merge window so the next edit starts a fresh undo
   * step. Loro merges edits within `mergeInterval` (default 1s); tests need a
   * deterministic way to force a step boundary without sleeping.
   */
  flushMergeWindow(): void;
}

export interface FutureSelectionRange {
  readonly anchor: { readonly blockId: BlockId; readonly offset: number };
  readonly focus: { readonly blockId: BlockId; readonly offset: number };
}

export interface FutureSelectionCommands {
  set(range: FutureSelectionRange): void;
  get(): FutureSelectionRange | null;
  selectAll(): void;
  collapse(blockId: BlockId, offset: number): void;
  insertText(value: string): void;
  deleteRange(): void;
  getTextContent(): string;
  getBlockIds(): ReadonlyArray<BlockId>;
}

export interface FutureBlockExtras {
  indent(args: { blockId: BlockId }): boolean;
  outdent(args: { blockId: BlockId }): boolean;
}

export interface FutureEditorSurface {
  setEditable(editable: boolean): void;
  isEditable(): boolean;
  clear(): void;
  focus(): void;
  blur(): void;
}

export interface FutureMarkCommands {
  update(args: {
    blockId: BlockId;
    range: { start: number; end: number };
    mark: MarkKind;
    value: unknown;
  }): void;
}

export interface FutureEditorCommands extends EditorCommands {
  readonly block: EditorCommands["block"] & FutureBlockExtras;
  readonly text: EditorCommands["text"] & { mark: FutureMarkCommands };
  readonly history: FutureHistoryCommands;
  readonly selection: FutureSelectionCommands;
}

export type FutureEditor = Editor & FutureEditorSurface & {
  readonly commands: FutureEditorCommands;
};

/** Cast helper — see file header for rationale. */
export const future = (editor: Editor): FutureEditor =>
  editor as unknown as FutureEditor;

/**
 * Apply mark callable in the existing surface, since `text.toggleMark` is
 * already implemented. Wraps the call into a name that reads more clearly
 * inside tests that aren't actually toggling.
 */
export const setMark = (
  editor: Editor,
  args: {
    blockId: BlockId;
    range: { start: number; end: number };
    mark: MarkKind;
    value?: unknown;
  },
): void => editor.commands.text.toggleMark(args);
