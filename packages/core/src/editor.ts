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
  ROOT_ID,
  blockKindHasInline,
  defaultAttrsFor,
} from "./block.js";

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
};

/** Every mark key the editor knows about — used to clear all formatting. */
const MARK_KEYS = Object.keys(DEFAULT_TEXT_STYLES);

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
  | "mention";

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

export interface Editor {
  readonly doc: LoroDoc;
  readonly tree: LoroTree;
  readonly origin: EditorOrigin;
  readonly commands: EditorCommands;
  setEditable(editable: boolean): void;
  isEditable(): boolean;
  clear(): void;
  focus(): void;
  blur(): void;
  dispose(): void;
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

  // `undo` is created after the (optional) seed commit so the empty-doc
  // template is not itself an undo step. History commands close over it.
  let undo: UndoManager | undefined;
  let editable = true;
  let currentSelection: SelectionRange | null = null;

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
    setEditable: (next: boolean) => {
      editable = next;
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
      currentSelection = null;
    },
    focus: () => {
      /* DOM concern — no-op at the core layer */
    },
    blur: () => {
      /* DOM concern — no-op at the core layer */
    },
    dispose: () => {
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

      toggleMark: ({ blockId, range, mark, value }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          // A zero-length range is a silent no-op — Loro's `mark` rejects
          // `start === end`.
          if (range.end <= range.start) return;
          const text = ensureText(node);
          const delta = text.toDelta() as DeltaRun[];
          let coverage = 0;
          let cursor = 0;
          for (const part of delta) {
            if (typeof part.insert !== "string") continue;
            const partStart = cursor;
            const partEnd = cursor + part.insert.length;
            const overlapStart = Math.max(partStart, range.start);
            const overlapEnd = Math.min(partEnd, range.end);
            if (overlapEnd > overlapStart) {
              const isOn =
                !!part.attributes && part.attributes[mark] !== undefined;
              if (isOn) coverage += overlapEnd - overlapStart;
            }
            cursor = partEnd;
          }
          const rangeLen = range.end - range.start;
          const fullyOn = rangeLen > 0 && coverage >= rangeLen;
          if (fullyOn) {
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
        }),

      clearMarks: ({ blockId, range }) =>
        withOrigin(() => {
          const node = getNode(tree, blockId);
          if (!node) return;
          if (range.end <= range.start) return;
          const text = ensureText(node);
          for (const key of MARK_KEYS) text.unmark(range, key);
        }),

      mark: {
        update: ({ blockId, range, mark, value }) =>
          withOrigin(() => {
            const node = getNode(tree, blockId);
            if (!node) return;
            if (range.end <= range.start) return;
            validateMarkValue(mark, value);
            const text = ensureText(node);
            text.mark(range, mark, value ?? true);
          }),
      },
    },

    history: {
      undo: () => undo?.undo() ?? false,
      redo: () => undo?.redo() ?? false,
      canUndo: () => undo?.canUndo() ?? false,
      canRedo: () => undo?.canRedo() ?? false,
      clearHistory: () => undo?.clear(),
      flushMergeWindow: () => {
        prevMergeable = false;
      },
    },

    selection: {
      set: (range) => {
        currentSelection = {
          anchor: { ...range.anchor },
          focus: { ...range.focus },
        };
      },

      get: () => currentSelection,

      selectAll: () => {
        const order = documentOrder();
        const first = order[0];
        const last = order[order.length - 1];
        if (first === undefined || last === undefined) {
          currentSelection = null;
          return;
        }
        currentSelection = {
          anchor: { blockId: first, offset: 0 },
          focus: { blockId: last, offset: textLengthOf(last) },
        };
      },

      collapse: (blockId, offset) => {
        const clamped = Math.max(0, Math.min(offset, textLengthOf(blockId)));
        currentSelection = {
          anchor: { blockId, offset: clamped },
          focus: { blockId, offset: clamped },
        };
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
    currentSelection = {
      anchor: { blockId: start.blockId, offset: caret },
      focus: { blockId: start.blockId, offset: caret },
    };
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
