import {
  LoroDoc,
  LoroMap,
  LoroText,
  LoroTree,
  LoroTreeNode,
  UndoManager,
  type TreeID,
} from "loro-crdt";
import {
  type AttrsFor,
  type Block,
  type BlockId,
  type BlockKind,
  BlockKindSchema,
  ROOT_ID,
  blockKindHasInline,
  defaultAttrsFor,
} from "./block.js";
import { type EditorEventHub, createEditorEventHub } from "./events.js";
import type { MentionMarkValue, PrincipalKind } from "./principal.js";

const TREE_NAME = "content";
const TEXT_KEY = "text";
const KIND_KEY = "kind";
const ATTRS_KEY = "attrs";

/**
 * Undo-step merge window (ms). All test commits are synchronous, so the
 * effective control is binary: `MERGE_INTERVAL_MS` lets a step coalesce with
 * the previous one, `0` forces a fresh step. See `withOrigin`.
 */
const MERGE_INTERVAL_MS = 1000;

const DEFAULT_TEXT_STYLES = {
  bold: { expand: "after" as const },
  italic: { expand: "after" as const },
  underline: { expand: "after" as const },
  strike: { expand: "after" as const },
  code: { expand: "none" as const },
  link: { expand: "none" as const },
  highlight: { expand: "after" as const },
  // A streamed agent insert should extend the marked run, so `expand: "after"`
  // (specs/ai-agent.md §5 — the marker pattern). The mark VALUE is the agent
  // id string (e.g. "agent-1").
  "agent-pending": { expand: "after" as const },
  // Mention spans are atomic from a typing-cursor standpoint; an insert at
  // either edge should NOT extend the mark (Lexical's TypeaheadMenuPlugin
  // mention nodes behave the same way).
  mention: { expand: "none" as const },
  // Comment anchors (Lexical's MarkNode; specs/lexical-parity.md §2) pin a
  // thread to the exact range the author selected — typing at either edge
  // must not grow the annotated span. The mark VALUE is `{ threadId }`; the
  // thread payload lives in a sibling LoroDoc container, not in the mark.
  "comment-anchor": { expand: "none" as const },
};

/** Every mark key the editor knows about. */
const MARK_KEYS = Object.keys(DEFAULT_TEXT_STYLES);

/** Marks a paste may carry across documents. Internal marks are excluded:
 *  `agent-pending` points at a live agent session and `comment-anchor` at a
 *  thread container — neither exists in the target doc, so transplanting
 *  them would create dangling references. Unknown keys are dropped too:
 *  they'd be committed to the CRDT (and replicate to every peer) while being
 *  invisible to the renderer's allowlist. */
const PASTEABLE_MARK_KEYS = new Set(
  MARK_KEYS.filter((k) => k !== "agent-pending" && k !== "comment-anchor"),
);

/** Block kinds a clipboard payload may materialize. */
const KNOWN_BLOCK_KINDS: ReadonlySet<string> = new Set(BlockKindSchema.literals);

/** Nesting cap for pasted fragments — a crafted payload with deeper nesting
 *  is rejected up front (stack-overflow guard; see validateClipboardBlocks). */
const MAX_PASTE_DEPTH = 32;

/** Mark keys removable by the user-facing clear-formatting command.
 *  `comment-anchor` is structural, not formatting (block-model.md §3 — "not
 *  exposed to formatting UI"): stripping bold/italic must not orphan a
 *  comment thread. Lexical's clear-formatting likewise leaves `MarkNode`
 *  annotations in place. */
const FORMAT_MARK_KEYS = MARK_KEYS.filter((k) => k !== "comment-anchor");

/** Marks whose Loro text-style `expand` is "after" — inserting at the trailing
 *  edge of these marks causes the new text to inherit the mark. Used by
 *  `block.merge` to prevent bleeding across block boundaries.
 *
 *  NOTE: Loro's default `expand` for an unconfigured style key is `"after"`,
 *  so a mark key *not* in `DEFAULT_TEXT_STYLES` would still bleed. Every mark
 *  the editor applies is configured in `DEFAULT_TEXT_STYLES`, so this is
 *  theoretical — but a future custom mark added without configuring its expand
 *  value would silently escape this filter. */
const EXPAND_AFTER_MARKS = new Set(
  Object.entries(DEFAULT_TEXT_STYLES)
    .filter(([, v]) => v.expand === "after")
    .map(([k]) => k),
);

export type MarkKind =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "highlight"
  | "agent-pending"
  | "mention"
  | "comment-anchor";

export type EditorOrigin = "user" | "agent" | "system" | (string & {});

export interface EditorOptions {
  readonly origin?: EditorOrigin;
  readonly seed?: boolean;
}

export interface SelectionRange {
  readonly anchor: { readonly blockId: BlockId; readonly offset: number };
  readonly focus: { readonly blockId: BlockId; readonly offset: number };
}

export interface HistoryCommands {
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clearHistory(): void;
  /** Close the current undo-merge window so the next edit starts a fresh step. */
  flushMergeWindow(): void;
}

export interface SelectionCommands {
  set(range: SelectionRange): void;
  get(): SelectionRange | null;
  selectAll(): void;
  collapse(blockId: BlockId, offset: number): void;
  insertText(value: string): void;
  deleteRange(): void;
  getTextContent(): string;
  getBlockIds(): ReadonlyArray<BlockId>;
}

export interface ClipboardDeltaRun {
  readonly insert: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * One block of a clipboard payload: kind + attrs + inline runs (with marks)
 * + nested children. The structured analog of Lexical's clipboard node JSON
 * (`application/x-lexical-editor`); the @weaver/dom bridge serializes this
 * as the `application/x-weaver` clipboard flavor.
 */
export interface ClipboardFragment {
  readonly kind: BlockKind;
  readonly attrs: Record<string, unknown>;
  /** Inline runs with marks; absent for non-inline kinds (divider, image…). */
  readonly delta?: ReadonlyArray<ClipboardDeltaRun>;
  readonly children: ReadonlyArray<ClipboardFragment>;
}

export interface ClipboardPayload {
  /** Plain-text rendering of the fragment, blocks joined by `\n`. */
  readonly text: string;
  /** Structured weaver fragment — kinds, attrs, marks, nesting. */
  readonly blocks: ReadonlyArray<ClipboardFragment>;
}

export interface ClipboardCommands {
  /** Serialize the current selection. `null` when collapsed or absent. */
  copy(): ClipboardPayload | null;
  /** `copy()` + delete the selected range. */
  cut(): ClipboardPayload | null;
  /**
   * Insert a payload at the current selection, replacing it when
   * non-collapsed. A payload without structured `blocks` (e.g. text copied
   * from another app) falls back to `pasteText`.
   */
  paste(payload: ClipboardPayload | { readonly text: string }): void;
  /** Plain-text paste: `\n` splits blocks, mirroring Enter between lines. */
  pasteText(value: string): void;
}

export interface Editor {
  readonly doc: LoroDoc;
  readonly tree: LoroTree;
  readonly origin: EditorOrigin;
  readonly commands: EditorCommands;
  /** Semantic editor events (mentions, …) — see `events.ts`. */
  readonly events: EditorEventHub;
  setEditable(editable: boolean): void;
  isEditable(): boolean;
  clear(): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  /**
   * Change notifications for editor state that lives OUTSIDE the LoroDoc
   * (selection, editable flag, undo-stack resets) — `doc.subscribe` cannot
   * observe these. Each returns an unsubscribe function; listeners fire
   * synchronously after the state change. The React hooks in `@weaver/react`
   * (`useSelection`, `useEditable`, `useUndoState` — lexical-parity §5)
   * consume them via `useSyncExternalStore`.
   */
  onSelectionChange(listener: () => void): () => void;
  onEditableChange(listener: () => void): () => void;
  onHistoryChange(listener: () => void): () => void;
}

export interface EditorCommands {
  readonly block: {
    insert(args: {
      parentId: BlockId;
      index: number;
      kind: BlockKind;
      attrs?: Record<string, unknown>;
    }): BlockId;
    split(args: { blockId: BlockId; offset: number }): BlockId;
    merge(args: { prevId: BlockId; nextId: BlockId }): void;
    transform(args: {
      blockId: BlockId;
      newKind: BlockKind;
      attrs?: Record<string, unknown>;
    }): void;
    delete(args: { blockId: BlockId }): void;
    indent(args: { blockId: BlockId }): boolean;
    outdent(args: { blockId: BlockId }): boolean;
    move(args: {
      blockId: BlockId;
      newParentId: BlockId;
      newIndex: number;
    }): boolean;
    setAttr(args: {
      blockId: BlockId;
      key: string;
      value: unknown;
    }): void;
  };
  readonly text: {
    insert(args: { blockId: BlockId; offset: number; value: string }): void;
    insertTab(args: { blockId: BlockId; offset: number }): void;
    delete(args: { blockId: BlockId; offset: number; length: number }): void;
    read(blockId: BlockId): string;
    length(blockId: BlockId): number;
    toDelta(blockId: BlockId): ReadonlyArray<unknown>;
    toggleMark(args: {
      blockId: BlockId;
      range: { start: number; end: number };
      mark: MarkKind;
      value?: unknown;
    }): void;
    clearMarks(args: {
      blockId: BlockId;
      range: { start: number; end: number };
    }): void;
    /**
     * Replace `[range.start, range.end)` — typically the `@query` trigger
     * text the user typed — with the principal's mention chip plus one
     * trailing space, atomically (one commit, one undo step). Returns the
     * character range of the marked label; the natural caret position is
     * `end + 1` (after the trailing space). Emits `MentionCreated`.
     */
    insertMention(args: {
      blockId: BlockId;
      range: { start: number; end: number };
      principal: { id: string; label: string; kind?: PrincipalKind };
    }): { start: number; end: number };
    readonly mark: {
      update(args: {
        blockId: BlockId;
        range: { start: number; end: number };
        mark: MarkKind;
        value: unknown;
      }): void;
    };
  };
  readonly history: HistoryCommands;
  readonly selection: SelectionCommands;
  readonly clipboard: ClipboardCommands;
}

interface DeltaRun {
  insert?: string;
  attributes?: Record<string, unknown>;
}

const getNode = (tree: LoroTree, id: BlockId): LoroTreeNode | undefined =>
  tree.getNodeByID(id as TreeID);

const getText = (node: LoroTreeNode): LoroText | undefined => {
  const v = node.data.get(TEXT_KEY) as LoroText | undefined;
  return v;
};

const requireText = (node: LoroTreeNode): LoroText => {
  const t = getText(node);
  if (!t) throw new Error(`block ${String(node.id)} has no inline text`);
  return t;
};

const ensureText = (node: LoroTreeNode): LoroText => {
  let t = getText(node);
  if (!t) t = node.data.setContainer(TEXT_KEY, new LoroText());
  return t;
};

const getKind = (node: LoroTreeNode): BlockKind => {
  const k = node.data.get(KIND_KEY) as BlockKind | undefined;
  return k ?? "paragraph";
};

const getAttrs = (node: LoroTreeNode): Record<string, unknown> => {
  const v = node.data.get(ATTRS_KEY);
  if (v instanceof LoroMap) {
    return v.toJSON() as Record<string, unknown>;
  }
  // Backwards compat: handle plain-object storage (pre-LoroMap format).
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
};

const childIds = (tree: LoroTree, id: BlockId): BlockId[] => {
  if (id === ROOT_ID) {
    return tree.roots().map((n) => String(n.id));
  }
  const node = getNode(tree, id);
  if (!node) return [];
  return (node.children() ?? []).map((c) => String(c.id));
};

/**
 * Whether `candidate` is `ancestor` itself or anywhere in its subtree. Used by
 * `block.move` to refuse cycle-forming reparents (a node cannot be moved
 * underneath itself or one of its own descendants).
 */
const isSelfOrDescendant = (
  tree: LoroTree,
  ancestor: BlockId,
  candidate: BlockId,
): boolean => {
  if (ancestor === candidate) return true;
  const stack: BlockId[] = [ancestor];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const child of childIds(tree, cur)) {
      if (child === candidate) return true;
      stack.push(child);
    }
  }
  return false;
};

/**
 * Slice a Loro delta to the character range `[start, end)`, preserving each
 * run's attributes. Used to carry marks across `block.split`.
 */
const sliceDelta = (
  delta: ReadonlyArray<DeltaRun>,
  start: number,
  end: number,
): DeltaRun[] => {
  const out: DeltaRun[] = [];
  let cursor = 0;
  for (const run of delta) {
    if (typeof run.insert !== "string") continue;
    const runStart = cursor;
    const runEnd = cursor + run.insert.length;
    const overlapStart = Math.max(runStart, start);
    const overlapEnd = Math.min(runEnd, end);
    if (overlapEnd > overlapStart) {
      out.push({
        insert: run.insert.slice(overlapStart - runStart, overlapEnd - runStart),
        attributes: run.attributes,
      });
    }
    cursor = runEnd;
  }
  return out;
};

/** Re-apply every mark carried by `delta` onto `text`, offset by `base`. */
const applyDeltaMarks = (
  text: LoroText,
  delta: ReadonlyArray<DeltaRun>,
  base: number,
): void => {
  let cursor = base;
  for (const run of delta) {
    if (typeof run.insert !== "string") continue;
    const len = run.insert.length;
    if (len > 0 && run.attributes) {
      for (const [key, val] of Object.entries(run.attributes)) {
        if (val === undefined || val === null || val === false) continue;
        text.mark({ start: cursor, end: cursor + len }, key, val);
      }
    }
    cursor += len;
  }
};

/**
 * Structural equality for mark values (booleans, strings, small plain
 * objects like `{ threadId }` / `{ href }`). JSON comparison is sufficient:
 * values are produced by our own commands, so key order is stable.
 */
const sameMarkValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Whether `mark` is present anywhere within `[start, end)` of `delta`. */
const hasMarkInRange = (
  delta: ReadonlyArray<DeltaRun>,
  mark: string,
  start: number,
  end: number,
): boolean => {
  let cursor = 0;
  for (const run of delta) {
    if (typeof run.insert !== "string") continue;
    const runStart = cursor;
    const runEnd = cursor + run.insert.length;
    if (
      Math.min(runEnd, end) > Math.max(runStart, start) &&
      run.attributes &&
      run.attributes[mark] !== undefined
    ) {
      return true;
    }
    cursor = runEnd;
  }
  return false;
};

/**
 * Reject mark payloads that violate the typed contract (ADR 0003 §marks).
 * A `link` value may be either a bare href string or a `{ href }` object;
 * either way the href must be a non-empty string.
 */
const validateMarkValue = (mark: MarkKind, value: unknown): void => {
  if (mark === "link") {
    const href =
      typeof value === "string"
        ? value
        : (value as { href?: unknown } | undefined)?.href;
    if (typeof href !== "string" || href.length === 0) {
      throw new Error("link mark requires a non-empty `href`");
    }
  }
  if (mark === "mention") {
    const v = value as { userId?: unknown; label?: unknown } | undefined;
    if (
      !v ||
      typeof v.userId !== "string" ||
      v.userId.length === 0 ||
      typeof v.label !== "string" ||
      v.label.length === 0
    ) {
      throw new Error(
        "mention mark requires `{ userId, label }` with non-empty strings",
      );
    }
  }
  if (mark === "comment-anchor") {
    const v = value as { threadId?: unknown } | undefined;
    if (!v || typeof v.threadId !== "string" || v.threadId.length === 0) {
      throw new Error(
        "comment-anchor mark requires `{ threadId }` with a non-empty string",
      );
    }
  }
};

/**
 * Order a selection's two endpoints into `[start, end]` document order.
 * `ai`/`fi` are the anchor/focus block indices in document order; when both
 * endpoints sit in the *same* block the offsets break the tie — without that,
 * a backward within-block selection (anchor offset > focus offset) yields a
 * negative-length range and silently deletes nothing.
 */
const orderEndpoints = (
  sel: SelectionRange,
  ai: number,
  fi: number,
): readonly [SelectionRange["anchor"], SelectionRange["focus"]] => {
  const forward =
    ai < fi || (ai === fi && sel.anchor.offset <= sel.focus.offset);
  return forward ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
};

export const rootId = (_editor: Editor): BlockId => ROOT_ID;

export const getBlock = <K extends BlockKind = BlockKind>(
  editor: Editor,
  id: BlockId,
): Block<K> | undefined => {
  if (id === ROOT_ID) return undefined;
  const node = getNode(editor.tree, id);
  if (!node) return undefined;
  if (node.isDeleted()) return undefined;
  const kind = getKind(node) as K;
  return {
    id,
    kind,
    attrs: getAttrs(node) as AttrsFor<K>,
    hasInline: blockKindHasInline(kind),
    childIds: childIds(editor.tree, id),
  };
};

export const getChildren = (editor: Editor, parentId: BlockId): BlockId[] =>
  childIds(editor.tree, parentId);

const setKindAttrs = (
  node: LoroTreeNode,
  kind: BlockKind,
  attrs?: Record<string, unknown>,
): void => {
  node.data.set(KIND_KEY, kind);
  if (attrs !== undefined) {
    const m = node.data.setContainer(ATTRS_KEY, new LoroMap());
    for (const [k, v] of Object.entries(attrs)) {
      m.set(k, v);
    }
  }
};

const initBlockNode = (
  node: LoroTreeNode,
  kind: BlockKind,
  attrs?: Record<string, unknown>,
): void => {
  setKindAttrs(node, kind, attrs ?? defaultAttrsFor(kind));
  if (blockKindHasInline(kind)) {
    ensureText(node);
  }
};

export const createEditor = (options: EditorOptions = {}): Editor => {
  const doc = new LoroDoc();
  doc.configTextStyle(DEFAULT_TEXT_STYLES);
  const tree = doc.getTree(TREE_NAME);
  const origin: EditorOrigin = options.origin ?? "user";
  const events = createEditorEventHub();

  // `undo` is created after the (optional) seed commit so the empty-doc
  // template is not itself an undo step. History commands close over it.
  let undo: UndoManager | undefined;
  let editable = true;
  let currentSelection: SelectionRange | null = null;

  const selectionListeners = new Set<() => void>();
  const editableListeners = new Set<() => void>();
  const historyListeners = new Set<() => void>();
  // Copy before iterating so a listener unsubscribing (or subscribing a new
  // listener) mid-notification can't corrupt the iteration.
  const notify = (listeners: Set<() => void>): void => {
    for (const fn of [...listeners]) fn();
  };
  const subscribe =
    (listeners: Set<() => void>) =>
    (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

  /** Assign `currentSelection` and notify selection listeners. */
  const setCurrentSelection = (next: SelectionRange | null): void => {
    currentSelection = next;
    notify(selectionListeners);
  };

  /**
   * Re-validate the selection against the (changed) document — undo/redo can
   * remove the selected block or shorten its text, and a stale selection
   * would point `useSelection` consumers at content that no longer exists.
   * Missing block → drop the selection; surviving block → clamp offsets.
   */
  const reconcileSelectionWithDoc = (): void => {
    const sel = currentSelection;
    if (!sel) return;
    const anchorNode = getNode(tree, sel.anchor.blockId);
    const focusNode = getNode(tree, sel.focus.blockId);
    if (
      !anchorNode ||
      anchorNode.isDeleted() ||
      !focusNode ||
      focusNode.isDeleted()
    ) {
      setCurrentSelection(null);
      return;
    }
    const clamp = (p: SelectionRange["anchor"]) => {
      const len = textLengthOf(p.blockId);
      return p.offset > len ? { blockId: p.blockId, offset: len } : p;
    };
    const anchor = clamp(sel.anchor);
    const focus = clamp(sel.focus);
    if (anchor !== sel.anchor || focus !== sel.focus) {
      setCurrentSelection({ anchor, focus });
    }
  };

  // Undo-step grouping: consecutive `text.insert`/`text.delete` ops merge into
  // a single step (one undo per typing burst); every other op forces a fresh
  // step. `flushMergeWindow` resets the run so the next text op starts fresh.
  let prevMergeable = false;

  /**
   * Run a mutation, commit it under the editor's origin, and tell the
   * UndoManager whether this step may coalesce with the previous one.
   */
  const withOrigin = <T>(fn: () => T, mergeable = false): T => {
    const result = fn();
    if (undo) {
      const wantMerge = mergeable && prevMergeable;
      undo.setMergeInterval(wantMerge ? MERGE_INTERVAL_MS : 0);
    }
    doc.commit({ origin });
    prevMergeable = mergeable;
    return result;
  };

  /**
   * Programmatic mention application (`toggleMark` / `mark.update` with
   * `mark: "mention"`) emits the same `MentionCreated` event as the
   * `insertMention` flow, so listeners see agent- and API-created mentions
   * too — not only picker-driven ones.
   */
  const emitIfMentionApplied = (
    blockId: BlockId,
    range: { start: number; end: number },
    mark: MarkKind,
    value: unknown,
  ): void => {
    if (mark !== "mention") return;
    if (range.end <= range.start) return;
    const v = value as MentionMarkValue | undefined;
    if (!v || typeof v.userId !== "string" || typeof v.label !== "string") {
      return;
    }
    events.emit({
      _tag: "MentionCreated",
      blockId,
      range: { start: range.start, end: range.end },
      principal: { id: v.userId, label: v.label, kind: v.kind },
      origin,
    });
  };

  /**
   * Run a composite mutation (paste, multi-line insert) as ONE undo step.
   * Each inner `withOrigin` still commits separately — the UndoManager group
   * coalesces them so Ctrl+Z reverts the whole gesture, mirroring Lexical's
   * `editor.update()` unit. Re-entrancy guarded: `groupStart` throws inside
   * an active group.
   */
  let grouping = false;
  const withUndoGroup = <T>(fn: () => T): T => {
    if (grouping || !undo) return fn();
    grouping = true;
    undo.groupStart();
    try {
      return fn();
    } finally {
      undo.groupEnd();
      grouping = false;
    }
  };

  const textLengthOf = (blockId: BlockId): number => {
    const node = getNode(tree, blockId);
    if (!node) return 0;
    const t = getText(node);
    return t ? t.length : 0;
  };

  const readTextOf = (blockId: BlockId): string => {
    const node = getNode(tree, blockId);
    if (!node) return "";
    const t = getText(node);
    return t ? t.toString() : "";
  };

  /** Flat depth-first list of every block id, in document order. */
  const documentOrder = (): BlockId[] => {
    const out: BlockId[] = [];
    const visit = (id: BlockId): void => {
      for (const childId of childIds(tree, id)) {
        out.push(childId);
        visit(childId);
      }
    };
    visit(ROOT_ID);
    return out;
  };

  const editor: Editor = {
    doc,
    tree,
    origin,
    commands: undefined as unknown as EditorCommands,
    events,
    setEditable: (next: boolean) => {
      if (editable === next) return;
      editable = next;
      notify(editableListeners);
    },
    isEditable: () => editable,
    clear: () => {
      withOrigin(() => {
        for (const id of childIds(tree, ROOT_ID)) {
          const n = getNode(tree, id);
          if (n) tree.delete(n.id);
        }
        const fresh = tree.createNode();
        initBlockNode(fresh, "paragraph", {});
      });
      setCurrentSelection(null);
    },
    onSelectionChange: subscribe(selectionListeners),
    onEditableChange: subscribe(editableListeners),
    onHistoryChange: subscribe(historyListeners),
    focus: () => {
      /* DOM concern — no-op at the core layer */
    },
    blur: () => {
      /* DOM concern — no-op at the core layer */
    },
    dispose: () => {
      events.dispose();
      try {
        undo?.free();
      } catch {
        // already freed
      }
      try {
        doc.free();
      } catch {
        // already freed
      }
    },
  };

  const commands: EditorCommands = {
    block: {
      insert: ({ parentId, index, kind, attrs }) =>
        withOrigin(() => {
          const newNode =
            parentId === ROOT_ID
              ? tree.createNode(undefined, index)
              : tree.createNode(parentId as TreeID, index);
          initBlockNode(newNode, kind, attrs);
          return String(newNode.id);
        }),

      split: ({ blockId, offset }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          const kind = getKind(node);
          const text = requireText(node);
          const fullLen = text.length;
          const safeOffset = Math.max(0, Math.min(offset, fullLen));
          const fullDelta = text.toDelta() as DeltaRun[];
          const tailDelta = sliceDelta(fullDelta, safeOffset, fullLen);
          const tail = text.slice(safeOffset, fullLen);
          if (tail.length > 0) text.delete(safeOffset, fullLen - safeOffset);
          const parent = node.parent();
          const myIndex = node.index() ?? 0;
          const newNode =
            parent === undefined
              ? tree.createNode(undefined, myIndex + 1)
              : tree.createNode(parent.id, myIndex + 1);
          initBlockNode(newNode, kind, getAttrs(node));
          if (tail.length > 0) {
            const newText = ensureText(newNode);
            newText.insert(0, tail);
            applyDeltaMarks(newText, tailDelta, 0);
          }
          return String(newNode.id);
        }),

      merge: ({ prevId, nextId }) =>
        withOrigin(() => {
          const prev = getNode(tree, prevId);
          const next = getNode(tree, nextId);
          if (!prev || !next) throw new Error("merge: missing block");
          const prevText = requireText(prev);
          const nextText = requireText(next);
          const nextDelta = nextText.toDelta() as DeltaRun[];
          const nextLen = nextText.length;
          const tail = nextText.toString();
          const base = prevText.length;
          if (nextLen > 0) {
            // The trailing run of `prev` may have `expand: "after"` marks; an
            // insert at the boundary would bleed them into `next`'s content.
            const prevDelta = prevText.toDelta() as DeltaRun[];
            const lastRun = prevDelta[prevDelta.length - 1];
            const bleedKeys = lastRun?.attributes
              ? Object.keys(lastRun.attributes).filter((k) =>
                  EXPAND_AFTER_MARKS.has(k),
                )
              : [];
            prevText.insert(base, tail);
            for (const key of bleedKeys) {
              prevText.unmark({ start: base, end: base + nextLen }, key);
            }
            applyDeltaMarks(prevText, nextDelta, base);
          }
          // `tree.delete` removes the whole subtree — adopt `next`'s children
          // under `prev` first, or nested blocks are silently destroyed.
          const adopted = next.children() ?? [];
          const adoptBase = (prev.children() ?? []).length;
          adopted.forEach((child, i) => child.move(prev, adoptBase + i));
          tree.delete(next.id);
        }),

      transform: ({ blockId, newKind, attrs }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          setKindAttrs(node, newKind, attrs ?? defaultAttrsFor(newKind));
          if (blockKindHasInline(newKind)) ensureText(node);
        }),

      delete: ({ blockId }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          tree.delete(node.id);
          // The editing surface must never have zero blocks (mirrors
          // Lexical's no-empty-root invariant).
          if (tree.roots().length === 0) {
            const fresh = tree.createNode();
            initBlockNode(fresh, "paragraph", {});
          }
        }),

      indent: ({ blockId }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return false;
          const parent = node.parent();
          const siblings = parent ? (parent.children() ?? []) : tree.roots();
          const idx = siblings.findIndex((n) => String(n.id) === blockId);
          if (idx <= 0) return false;
          const prev = siblings[idx - 1]!;
          const prevChildren = prev.children() ?? [];
          node.move(prev, prevChildren.length);
          return true;
        }),

      outdent: ({ blockId }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return false;
          const parent = node.parent();
          if (!parent) return false; // already at the top level
          const grandparent = parent.parent();
          const parentIndex = parent.index() ?? 0;
          node.move(grandparent ?? undefined, parentIndex + 1);
          return true;
        }),

      move: ({ blockId, newParentId, newIndex }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return false;
          // Cannot reparent under self or any descendant — would form a cycle.
          if (
            newParentId !== ROOT_ID &&
            isSelfOrDescendant(tree, blockId, newParentId)
          ) {
            return false;
          }
          const target =
            newParentId === ROOT_ID ? undefined : getNode(tree, newParentId);
          if (newParentId !== ROOT_ID && !target) return false;
          const siblings = target ? (target.children() ?? []) : tree.roots();
          // When moving WITHIN the same parent, Loro reorders the existing
          // child so `newIndex` is the post-move slot in the unchanged-length
          // sibling list (max index = siblings.length - 1). When moving to a
          // DIFFERENT parent the slot is in the target's list which grows by
          // one (max index = siblings.length).
          const currentParent = node.parent();
          const sameParent = target
            ? currentParent?.id === target.id
            : currentParent === undefined;
          const maxIndex = sameParent
            ? Math.max(0, siblings.length - 1)
            : siblings.length;
          const clamped = Math.max(0, Math.min(newIndex, maxIndex));
          node.move(target, clamped);
          return true;
        }),

      setAttr: ({ blockId, key, value }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          const v = node.data.get(ATTRS_KEY);
          // get-or-create the LoroMap container. Two peers calling setAttr on
          // a block with no attrs container yet will each race to
          // setContainer() — Loro ensures one wins and the other sees the
          // winner's container, so the per-key .set() below converges.
          const m = v instanceof LoroMap
            ? v
            : node.data.setContainer(ATTRS_KEY, new LoroMap());
          m.set(key, value);
        }),
    },

    text: {
      insert: ({ blockId, offset, value }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          if (!blockKindHasInline(getKind(node))) {
            throw new Error(
              `block ${blockId} (kind ${getKind(node)}) has no inline text`,
            );
          }
          const text = ensureText(node);
          const len = text.length;
          const safeOffset = Math.max(0, Math.min(offset, len));
          text.insert(safeOffset, value);
        }, true),

      insertTab: ({ blockId, offset }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          if (!blockKindHasInline(getKind(node))) {
            throw new Error(
              `block ${blockId} (kind ${getKind(node)}) has no inline text`,
            );
          }
          const text = ensureText(node);
          const len = text.length;
          const safeOffset = Math.max(0, Math.min(offset, len));
          text.insert(safeOffset, "\t");
        }, true),

      delete: ({ blockId, offset, length }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          const text = getText(node);
          if (!text) return;
          const len = text.length;
          const start = Math.max(0, Math.min(offset, len));
          const removable = Math.max(0, Math.min(length, len - start));
          if (removable > 0) text.delete(start, removable);
        }, true),

      read: (blockId) => readTextOf(blockId),

      length: (blockId) => textLengthOf(blockId),

      toDelta: (blockId) => {
        const node = getNode(tree, blockId);
        if (!node) return [];
        const text = getText(node);
        return text ? text.toDelta() : [];
      },

      toggleMark: ({ blockId, range, mark, value }) => {
        let applied = false;
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          // A zero-length range is a silent no-op — Loro's `mark` rejects
          // `start === end`.
          if (range.end <= range.start) return;
          const text = ensureText(node);
          const delta = text.toDelta() as DeltaRun[];
          let coverage = 0;
          let coverageSameValue = 0;
          let cursor = 0;
          const requested = value ?? true;
          for (const part of delta) {
            if (typeof part.insert !== "string") continue;
            const partStart = cursor;
            const partEnd = cursor + part.insert.length;
            const overlapStart = Math.max(partStart, range.start);
            const overlapEnd = Math.min(partEnd, range.end);
            if (overlapEnd > overlapStart) {
              const existing = part.attributes?.[mark];
              if (existing !== undefined) {
                const len = overlapEnd - overlapStart;
                coverage += len;
                if (sameMarkValue(existing, requested)) coverageSameValue += len;
              }
            }
            cursor = partEnd;
          }
          const rangeLen = range.end - range.start;
          const fullyOn = rangeLen > 0 && coverage >= rangeLen;
          // Fully-covered range: calling with NO value (the plain toggle
          // gesture) or with the SAME value toggles the mark off. Calling
          // with a DIFFERENT value (new comment threadId, new highlight
          // color, new link href) is a REPLACE — the mark() below overwrites
          // it — never a silent removal.
          if (fullyOn && (value === undefined || coverageSameValue >= rangeLen)) {
            text.unmark(range, mark);
            return;
          }
          validateMarkValue(mark, value);
          // `code` and `link` are mutually exclusive over the same span
          // (specs/lexical-parity.md §2).
          if (
            mark === "code" &&
            hasMarkInRange(delta, "link", range.start, range.end)
          ) {
            text.unmark(range, "link");
          } else if (
            mark === "link" &&
            hasMarkInRange(delta, "code", range.start, range.end)
          ) {
            text.unmark(range, "code");
          }
          text.mark(range, mark, value ?? true);
          applied = true;
        });
        if (applied) emitIfMentionApplied(blockId, range, mark, value);
      },

      clearMarks: ({ blockId, range }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          if (range.end <= range.start) return;
          const text = ensureText(node);
          for (const key of FORMAT_MARK_KEYS) text.unmark(range, key);
        }),

      insertMention: ({ blockId, range, principal }) => {
        const node = getNode(tree, blockId);
        if (!node) throw new Error(`block ${blockId} not found`);
        if (!blockKindHasInline(getKind(node))) {
          throw new Error(
            `block ${blockId} (kind ${getKind(node)}) has no inline text`,
          );
        }
        const label = principal.label.startsWith("@")
          ? principal.label
          : `@${principal.label}`;
        const value: MentionMarkValue = {
          userId: principal.id,
          label,
          ...(principal.kind !== undefined ? { kind: principal.kind } : {}),
        };
        validateMarkValue("mention", value);
        const marked = withOrigin(() => {
          const text = ensureText(node);
          const len = text.length;
          const start = Math.max(0, Math.min(range.start, len));
          const end = Math.max(start, Math.min(range.end, len));
          if (end > start) text.delete(start, end - start);
          // Label + one trailing space; `mention` is `expand: "none"` so the
          // space stays unmarked and the caret can sit after the chip.
          text.insert(start, `${label} `);
          text.mark({ start, end: start + label.length }, "mention", value);
          return { start, end: start + label.length };
        });
        events.emit({
          _tag: "MentionCreated",
          blockId,
          range: marked,
          principal: { id: principal.id, label, kind: principal.kind },
          origin,
        });
        return marked;
      },

      mark: {
        update: ({ blockId, range, mark, value }) => {
          let applied = false;
          withOrigin(() => {
            const node = getNode(tree, blockId);
            if (!node) return;
            if (range.end <= range.start) return;
            validateMarkValue(mark, value);
            const text = ensureText(node);
            text.mark(range, mark, value ?? true);
            applied = true;
          });
          // Guarded so a write that didn't happen (block deleted by a peer,
          // empty range) can't emit a phantom MentionCreated.
          if (applied) emitIfMentionApplied(blockId, range, mark, value);
        },
      },
    },

    history: {
      undo: () => {
        const did = undo?.undo() ?? false;
        if (did) {
          reconcileSelectionWithDoc();
          notify(historyListeners);
        }
        return did;
      },
      redo: () => {
        const did = undo?.redo() ?? false;
        if (did) {
          reconcileSelectionWithDoc();
          notify(historyListeners);
        }
        return did;
      },
      canUndo: () => undo?.canUndo() ?? false,
      canRedo: () => undo?.canRedo() ?? false,
      clearHistory: () => {
        undo?.clear();
        notify(historyListeners);
      },
      flushMergeWindow: () => {
        prevMergeable = false;
      },
    },

    selection: {
      set: (range) => {
        setCurrentSelection({
          anchor: { ...range.anchor },
          focus: { ...range.focus },
        });
      },

      get: () => currentSelection,

      selectAll: () => {
        const order = documentOrder();
        const first = order[0];
        const last = order[order.length - 1];
        if (first === undefined || last === undefined) {
          setCurrentSelection(null);
          return;
        }
        setCurrentSelection({
          anchor: { blockId: first, offset: 0 },
          focus: { blockId: last, offset: textLengthOf(last) },
        });
      },

      collapse: (blockId, offset) => {
        const clamped = Math.max(0, Math.min(offset, textLengthOf(blockId)));
        setCurrentSelection({
          anchor: { blockId, offset: clamped },
          focus: { blockId, offset: clamped },
        });
      },

      getTextContent: () => {
        const sel = currentSelection;
        if (!sel) return "";
        const order = documentOrder();
        const ai = order.indexOf(sel.anchor.blockId);
        const fi = order.indexOf(sel.focus.blockId);
        if (ai < 0 || fi < 0) return "";
        const [start, end] = orderEndpoints(sel, ai, fi);
        if (start.blockId === end.blockId) {
          return readTextOf(start.blockId).slice(start.offset, end.offset);
        }
        const ids = order.slice(Math.min(ai, fi), Math.max(ai, fi) + 1);
        const parts: string[] = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          const text = readTextOf(id);
          if (i === 0) parts.push(text.slice(start.offset));
          else if (i === ids.length - 1) parts.push(text.slice(0, end.offset));
          else parts.push(text);
        }
        return parts.join("\n");
      },

      getBlockIds: () => {
        const sel = currentSelection;
        if (!sel) return [];
        const order = documentOrder();
        const ai = order.indexOf(sel.anchor.blockId);
        const fi = order.indexOf(sel.focus.blockId);
        if (ai < 0 || fi < 0) return [];
        return order.slice(Math.min(ai, fi), Math.max(ai, fi) + 1);
      },

      insertText: (value) => mutateSelectionRange(value),
      deleteRange: () => mutateSelectionRange(null),
    },

    clipboard: {
      copy: () => buildClipboardPayload(),
      cut: () => {
        const payload = buildClipboardPayload();
        if (!payload) return null;
        mutateSelectionRange(null);
        return payload;
      },
      paste: (payload) => {
        const blocks = "blocks" in payload ? payload.blocks : undefined;
        if (!blocks || blocks.length === 0) {
          withUndoGroup(() => pasteTextImpl(payload.text));
          return;
        }
        // Validate the FULL payload before any mutation starts — a malformed
        // fragment discovered mid-paste would otherwise leave the doc with a
        // partial (split + some blocks) state that no error handler can roll
        // back.
        validateClipboardBlocks(blocks, 0);
        withUndoGroup(() => pasteStructured(blocks));
      },
      pasteText: (value) => withUndoGroup(() => pasteTextImpl(value)),
    },
  };

  /**
   * Replace the current selection with `value` (or just delete it when
   * `value` is `null`). A multi-block range merges the touched blocks into
   * the anchor block, mirroring Lexical's `$insertText` on a range.
   */
  function mutateSelectionRange(value: string | null): void {
    const sel = currentSelection;
    if (!sel) return;
    const order = documentOrder();
    const ai = order.indexOf(sel.anchor.blockId);
    const fi = order.indexOf(sel.focus.blockId);
    if (ai < 0 || fi < 0) return;
    const [start, end] = orderEndpoints(sel, ai, fi);

    if (start.blockId === end.blockId) {
      const len = end.offset - start.offset;
      if (len > 0) {
        commands.text.delete({
          blockId: start.blockId,
          offset: start.offset,
          length: len,
        });
      }
      if (value) {
        commands.text.insert({
          blockId: start.blockId,
          offset: start.offset,
          value,
        });
      }
    } else {
      const ids = order.slice(Math.min(ai, fi), Math.max(ai, fi) + 1);
      const startLen = textLengthOf(start.blockId);
      if (startLen > start.offset) {
        commands.text.delete({
          blockId: start.blockId,
          offset: start.offset,
          length: startLen - start.offset,
        });
      }
      for (let i = 1; i < ids.length; i++) {
        const id = ids[i]!;
        const idNode = getNode(tree, id);
        const idHasInline = idNode
          ? blockKindHasInline(getKind(idNode))
          : false;
        if (id === end.blockId) {
          if (idHasInline && end.offset > 0) {
            commands.text.delete({ blockId: id, offset: 0, length: end.offset });
          }
        } else if (idHasInline) {
          const l = textLengthOf(id);
          if (l > 0) commands.text.delete({ blockId: id, offset: 0, length: l });
        }
        if (idHasInline) {
          commands.block.merge({ prevId: start.blockId, nextId: id });
        } else {
          // Non-inline blocks (divider, image, embed) between endpoints get
          // deleted outright — `block.merge` would call `requireText` and
          // throw. The deletion still leaves at least the anchor block, so
          // the no-empty-root invariant is upheld.
          commands.block.delete({ blockId: id });
        }
      }
      if (value) {
        commands.text.insert({
          blockId: start.blockId,
          offset: start.offset,
          value,
        });
      }
    }

    const caret = start.offset + (value ? value.length : 0);
    setCurrentSelection({
      anchor: { blockId: start.blockId, offset: caret },
      focus: { blockId: start.blockId, offset: caret },
    });
  }

  /**
   * Serialize the current selection into a `ClipboardPayload`. Nesting is
   * preserved: a selected block whose parent is also selected becomes a child
   * fragment; otherwise it surfaces as a top-level fragment.
   */
  function buildClipboardPayload(): ClipboardPayload | null {
    const sel = currentSelection;
    if (!sel) return null;
    const order = documentOrder();
    const ai = order.indexOf(sel.anchor.blockId);
    const fi = order.indexOf(sel.focus.blockId);
    if (ai < 0 || fi < 0) return null;
    if (ai === fi && sel.anchor.offset === sel.focus.offset) return null;
    const [start, end] = orderEndpoints(sel, ai, fi);
    const ids = order.slice(Math.min(ai, fi), Math.max(ai, fi) + 1);

    interface MutableFragment {
      kind: BlockKind;
      attrs: Record<string, unknown>;
      delta?: ClipboardDeltaRun[];
      children: MutableFragment[];
    }
    const fragOf = new Map<BlockId, MutableFragment>();
    const top: MutableFragment[] = [];
    for (const id of ids) {
      const node = getNode(tree, id);
      if (!node) continue;
      const kind = getKind(node);
      const frag: MutableFragment = { kind, attrs: getAttrs(node), children: [] };
      if (blockKindHasInline(kind)) {
        const text = getText(node);
        const full = text ? (text.toDelta() as DeltaRun[]) : [];
        const len = text ? text.length : 0;
        const from = id === start.blockId ? start.offset : 0;
        const to = id === end.blockId ? end.offset : len;
        frag.delta = sliceDelta(full, from, to).map((run) =>
          run.attributes && Object.keys(run.attributes).length > 0
            ? { insert: run.insert ?? "", attributes: run.attributes }
            : { insert: run.insert ?? "" },
        );
      }
      const parent = node.parent();
      const parentFrag = parent ? fragOf.get(String(parent.id)) : undefined;
      if (parentFrag) parentFrag.children.push(frag);
      else top.push(frag);
      fragOf.set(id, frag);
    }
    return { text: commands.selection.getTextContent(), blocks: top };
  }

  /**
   * Reject malformed payloads (foreign apps, crafted clipboard contents)
   * before any doc mutation: unknown kinds, non-string inserts, nesting past
   * MAX_PASTE_DEPTH (stack-overflow guard for createFragmentBlock).
   */
  function validateClipboardBlocks(
    blocks: ReadonlyArray<ClipboardFragment>,
    depth: number,
  ): void {
    if (depth > MAX_PASTE_DEPTH) {
      throw new Error(
        `clipboard payload exceeds max nesting depth ${MAX_PASTE_DEPTH}`,
      );
    }
    for (const frag of blocks) {
      if (!frag || typeof frag !== "object") {
        throw new Error("clipboard fragment must be an object");
      }
      if (!KNOWN_BLOCK_KINDS.has(frag.kind as string)) {
        throw new Error(
          `clipboard fragment has unknown block kind "${String(frag.kind)}"`,
        );
      }
      if (frag.delta !== undefined) {
        for (const run of frag.delta) {
          if (typeof run?.insert !== "string") {
            throw new Error("clipboard delta run must have a string insert");
          }
        }
      }
      validateClipboardBlocks(frag.children ?? [], depth + 1);
    }
  }

  /** Concatenated inline text of a fragment (excluding children). */
  function fragmentTextLength(frag: ClipboardFragment): number {
    return (frag.delta ?? []).reduce((n, run) => n + run.insert.length, 0);
  }

  /** Whether a fragment can merge into surrounding inline text. */
  function isInlineFragment(frag: ClipboardFragment): boolean {
    return blockKindHasInline(frag.kind) && frag.delta !== undefined;
  }

  /**
   * Insert a fragment's inline runs into `blockId` at `offset`, re-applying
   * marks and suppressing `expand: "after"` bleed from the character before
   * the insertion point (same guard as `block.merge`). Returns the inserted
   * length.
   */
  function insertDeltaInline(
    blockId: BlockId,
    offset: number,
    delta: ReadonlyArray<ClipboardDeltaRun>,
  ): number {
    const value = delta.map((run) => run.insert).join("");
    if (!value) return 0;
    const node = getNode(tree, blockId);
    if (!node) return 0;
    withOrigin(() => {
      const text = ensureText(node);
      const prevDelta = text.toDelta() as DeltaRun[];
      const before = sliceDelta(prevDelta, Math.max(0, offset - 1), offset);
      const bleedKeys = before[0]?.attributes
        ? Object.keys(before[0].attributes).filter((k) =>
            EXPAND_AFTER_MARKS.has(k),
          )
        : [];
      text.insert(offset, value);
      for (const key of bleedKeys) {
        text.unmark({ start: offset, end: offset + value.length }, key);
      }
      // Whitelist marks at the document boundary — see PASTEABLE_MARK_KEYS.
      const sanitized: DeltaRun[] = delta.map((run) => {
        if (!run.attributes) return { insert: run.insert };
        const attributes: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(run.attributes)) {
          if (PASTEABLE_MARK_KEYS.has(key)) attributes[key] = v;
        }
        return Object.keys(attributes).length > 0
          ? { insert: run.insert, attributes }
          : { insert: run.insert };
      });
      applyDeltaMarks(text, sanitized, offset);
    });
    return value.length;
  }

  /** Materialize a fragment (and its children) as a new block subtree. */
  function createFragmentBlock(
    parentId: BlockId,
    index: number,
    frag: ClipboardFragment,
  ): BlockId {
    const id = commands.block.insert({
      parentId,
      index,
      kind: frag.kind,
      attrs: frag.attrs,
    });
    if (frag.delta && blockKindHasInline(frag.kind)) {
      insertDeltaInline(id, 0, frag.delta);
    }
    (frag.children ?? []).forEach((child, i) => createFragmentBlock(id, i, child));
    return id;
  }

  /**
   * Structured paste, mirroring Lexical's `$insertNodes` on a range: the
   * anchor block splits at the caret; the first inline fragment merges into
   * the anchor head; the last inline childless fragment absorbs the tail;
   * everything else lands as sibling blocks in between.
   */
  function pasteStructured(blocks: ReadonlyArray<ClipboardFragment>): void {
    const sel = currentSelection;
    if (!sel) return;
    const collapsed =
      sel.anchor.blockId === sel.focus.blockId &&
      sel.anchor.offset === sel.focus.offset;
    if (!collapsed) mutateSelectionRange(null);
    const caret = currentSelection;
    if (!caret) return;
    const anchorId = caret.anchor.blockId;
    const offset = caret.anchor.offset;

    const first = blocks[0]!;
    if (
      blocks.length === 1 &&
      isInlineFragment(first) &&
      first.children.length === 0
    ) {
      const n = insertDeltaInline(anchorId, offset, first.delta!);
      commands.selection.collapse(anchorId, offset + n);
      return;
    }

    const tailId = commands.block.split({ blockId: anchorId, offset });
    let idx = 0;
    const mergedIntoAnchor =
      isInlineFragment(first) && first.children.length === 0;
    if (mergedIntoAnchor) {
      insertDeltaInline(anchorId, offset, first.delta!);
      idx = 1;
    }

    const anchorNode = getNode(tree, anchorId);
    const parent = anchorNode?.parent();
    const parentId = parent ? String(parent.id) : ROOT_ID;
    let insertIndex = (anchorNode?.index() ?? 0) + 1;
    let last: { id: BlockId; frag: ClipboardFragment } | null = null;
    for (; idx < blocks.length; idx++) {
      const frag = blocks[idx]!;
      last = { id: createFragmentBlock(parentId, insertIndex, frag), frag };
      insertIndex += 1;
    }

    // Mirror of the empty-tail drop below: when nothing merged into the
    // anchor (first fragment was structural) and the split left it empty —
    // e.g. pasting a divider at offset 0 — the empty head block is an
    // artifact of the split, not content.
    if (
      !mergedIntoAnchor &&
      textLengthOf(anchorId) === 0 &&
      childIds(tree, anchorId).length === 0
    ) {
      commands.block.delete({ blockId: anchorId });
    }

    if (last && isInlineFragment(last.frag) && last.frag.children.length === 0) {
      const caretOffset = fragmentTextLength(last.frag);
      commands.block.merge({ prevId: last.id, nextId: tailId });
      commands.selection.collapse(last.id, caretOffset);
      return;
    }
    // The tail couldn't merge (last fragment is non-inline or has children).
    // An empty tail is dropped — otherwise pasting at the end of a block
    // would strand an empty paragraph after the pasted content.
    if (textLengthOf(tailId) === 0 && childIds(tree, tailId).length === 0) {
      commands.block.delete({ blockId: tailId });
      if (last) {
        commands.selection.collapse(
          last.id,
          isInlineFragment(last.frag) ? fragmentTextLength(last.frag) : 0,
        );
      }
      return;
    }
    commands.selection.collapse(tailId, 0);
  }

  /** Plain-text paste: first line via `insertText`, each `\n` via `split`. */
  function pasteTextImpl(value: string): void {
    if (!currentSelection) return;
    if (value === "") return;
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    mutateSelectionRange(lines[0]!);
    const sel = currentSelection;
    if (!sel) return;
    let cur = sel.anchor.blockId;
    let caretOffset = sel.anchor.offset;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      cur = commands.block.split({ blockId: cur, offset: caretOffset });
      if (line.length > 0) {
        commands.text.insert({ blockId: cur, offset: 0, value: line });
      }
      caretOffset = line.length;
    }
    commands.selection.collapse(cur, caretOffset);
  }

  (editor as { commands: EditorCommands }).commands = commands;

  if (options.seed !== false) {
    seedEmptyDoc();
  }

  // Created last so neither the seed nor any pre-history setup is an undo step.
  undo = new UndoManager(doc, { mergeInterval: MERGE_INTERVAL_MS });

  function seedEmptyDoc(): void {
    if (tree.roots().length > 0) return;
    withOrigin(() => {
      const node = tree.createNode();
      initBlockNode(node, "paragraph", {});
    });
  }

  return editor;
};

export const blockLength = (editor: Editor, blockId: BlockId): number =>
  editor.commands.text.length(blockId);

export { ROOT_ID } from "./block.js";
