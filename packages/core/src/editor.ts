import { LoroDoc, LoroText, LoroTree, LoroTreeNode, type TreeID } from "loro-crdt";
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

const DEFAULT_TEXT_STYLES = {
  bold: { expand: "after" as const },
  italic: { expand: "after" as const },
  underline: { expand: "after" as const },
  strike: { expand: "after" as const },
  code: { expand: "none" as const },
  link: { expand: "none" as const },
  highlight: { expand: "after" as const },
};

export type MarkKind =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "highlight";

export type EditorOrigin = "user" | "agent" | "system" | (string & {});

export interface EditorOptions {
  readonly origin?: EditorOrigin;
  readonly seed?: boolean;
}

export interface Editor {
  readonly doc: LoroDoc;
  readonly tree: LoroTree;
  readonly origin: EditorOrigin;
  readonly commands: EditorCommands;
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
  };
  readonly text: {
    insert(args: { blockId: BlockId; offset: number; value: string }): void;
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
  };
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
  const a = node.data.get(ATTRS_KEY) as Record<string, unknown> | undefined;
  return a ?? {};
};

const childIds = (tree: LoroTree, id: BlockId): BlockId[] => {
  if (id === ROOT_ID) {
    return tree.roots().map((n) => String(n.id));
  }
  const node = getNode(tree, id);
  if (!node) return [];
  return (node.children() ?? []).map((c) => String(c.id));
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
    node.data.set(ATTRS_KEY, { ...attrs });
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

const withOrigin = <T>(editor: Editor, fn: () => T): T => {
  const result = fn();
  editor.doc.commit({ origin: editor.origin });
  return result;
};

const seedEmptyDoc = (editor: Editor): void => {
  if (editor.tree.roots().length > 0) return;
  withOrigin(editor, () => {
    const node = editor.tree.createNode();
    initBlockNode(node, "paragraph", {});
  });
};

export const createEditor = (options: EditorOptions = {}): Editor => {
  const doc = new LoroDoc();
  doc.configTextStyle(DEFAULT_TEXT_STYLES);
  const tree = doc.getTree(TREE_NAME);

  const editor: Editor = {
    doc,
    tree,
    origin: options.origin ?? "user",
    commands: undefined as unknown as EditorCommands,
    dispose: () => {
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
        withOrigin(editor, () => {
          const newNode =
            parentId === ROOT_ID
              ? tree.createNode(undefined, index)
              : tree.createNode(parentId as TreeID, index);
          initBlockNode(newNode, kind, attrs);
          return String(newNode.id);
        }),

      split: ({ blockId, offset }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          const kind = getKind(node);
          const text = requireText(node);
          const fullLen = text.length;
          const safeOffset = Math.max(0, Math.min(offset, fullLen));
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
          }
          return String(newNode.id);
        }),

      merge: ({ prevId, nextId }) =>
        withOrigin(editor, () => {
          const prev = getNode(tree, prevId);
          const next = getNode(tree, nextId);
          if (!prev || !next) throw new Error("merge: missing block");
          const prevText = requireText(prev);
          const nextText = requireText(next);
          const tail = nextText.toString();
          if (tail.length > 0) prevText.insert(prevText.length, tail);
          tree.delete(next.id);
        }),

      transform: ({ blockId, newKind, attrs }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          setKindAttrs(node, newKind, attrs ?? defaultAttrsFor(newKind));
          if (blockKindHasInline(newKind)) ensureText(node);
        }),

      delete: ({ blockId }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) return;
          tree.delete(node.id);
        }),
    },
    text: {
      insert: ({ blockId, offset, value }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) throw new Error(`block ${blockId} not found`);
          const text = ensureText(node);
          const len = text.length;
          const safeOffset = Math.max(0, Math.min(offset, len));
          text.insert(safeOffset, value);
        }),

      delete: ({ blockId, offset, length }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) return;
          const text = getText(node);
          if (!text) return;
          const len = text.length;
          const start = Math.max(0, Math.min(offset, len));
          const removable = Math.max(0, Math.min(length, len - start));
          if (removable > 0) text.delete(start, removable);
        }),

      read: (blockId) => {
        const node = getNode(tree, blockId);
        if (!node) return "";
        const text = getText(node);
        return text ? text.toString() : "";
      },

      length: (blockId) => {
        const node = getNode(tree, blockId);
        if (!node) return 0;
        const text = getText(node);
        return text ? text.length : 0;
      },

      toDelta: (blockId) => {
        const node = getNode(tree, blockId);
        if (!node) return [];
        const text = getText(node);
        return text ? text.toDelta() : [];
      },

      toggleMark: ({ blockId, range, mark, value }) =>
        withOrigin(editor, () => {
          const node = getNode(tree, blockId);
          if (!node) return;
          const text = ensureText(node);
          const delta = text.toDelta();
          let coverage = 0;
          let cursor = 0;
          for (const part of delta as Array<{
            insert?: string;
            attributes?: Record<string, unknown>;
          }>) {
            if (typeof part.insert !== "string") continue;
            const partStart = cursor;
            const partEnd = cursor + part.insert.length;
            const overlapStart = Math.max(partStart, range.start);
            const overlapEnd = Math.min(partEnd, range.end);
            if (overlapEnd > overlapStart) {
              const isOn = !!part.attributes && part.attributes[mark] !== undefined;
              if (isOn) coverage += overlapEnd - overlapStart;
            }
            cursor = partEnd;
          }
          const rangeLen = Math.max(0, range.end - range.start);
          const fullyOn = rangeLen > 0 && coverage >= rangeLen;
          if (fullyOn) {
            text.unmark(range, mark);
          } else {
            text.mark(range, mark, value ?? true);
          }
        }),
    },
  };

  (editor as { commands: EditorCommands }).commands = commands;

  if (options.seed !== false) {
    seedEmptyDoc(editor);
  }

  return editor;
};

export const blockLength = (editor: Editor, blockId: BlockId): number =>
  editor.commands.text.length(blockId);

export { ROOT_ID } from "./block.js";
