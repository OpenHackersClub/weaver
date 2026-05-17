import { useEffect, useRef, useState } from "react";
import {
  type Block,
  type BlockId,
  type Editor,
  type EditorOptions,
  createEditor,
  getBlock,
  getChildren,
  rootId,
} from "@weaver/core";

/**
 * Create a single Editor instance for the lifetime of the host React component.
 * The editor is owned by the hook and disposed on unmount.
 *
 * Resilient to React 19 + StrictMode double-mount: lazy `useState` returns the
 * same editor across re-renders, and disposal happens in `useEffect` cleanup.
 */
export const useEditor = (options: EditorOptions = {}): Editor => {
  const optsRef = useRef(options);
  optsRef.current = options;
  const [editor] = useState(() => createEditor(optsRef.current));
  useEffect(() => {
    return () => {
      editor.dispose();
    };
  }, [editor]);
  return editor;
};

const sameBlockIds = (
  a: ReadonlyArray<BlockId>,
  b: ReadonlyArray<BlockId>,
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const sameBlock = (
  a: Block | undefined,
  b: Block | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.hasInline !== b.hasInline) return false;
  if (!sameBlockIds(a.childIds, b.childIds)) return false;
  if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) return false;
  return true;
};

export const useChildren = (
  editor: Editor,
  parentId: BlockId,
): ReadonlyArray<BlockId> => {
  const [children, setChildren] = useState<ReadonlyArray<BlockId>>(() =>
    getChildren(editor, parentId),
  );
  useEffect(() => {
    const update = () => {
      const next = getChildren(editor, parentId);
      setChildren((prev) => (sameBlockIds(prev, next) ? prev : next));
    };
    update();
    const unsub = editor.doc.subscribe(() => update());
    return () => unsub();
  }, [editor, parentId]);
  return children;
};

export const useRootChildren = (editor: Editor): ReadonlyArray<BlockId> =>
  useChildren(editor, rootId(editor));

export const useBlock = (editor: Editor, id: BlockId): Block | undefined => {
  const [block, setBlock] = useState<Block | undefined>(() => getBlock(editor, id));
  useEffect(() => {
    const update = () => {
      const next = getBlock(editor, id);
      setBlock((prev) => (sameBlock(prev, next) ? prev : next));
    };
    update();
    const unsub = editor.doc.subscribe(() => update());
    return () => unsub();
  }, [editor, id]);
  return block;
};

export const useDocSnapshot = (editor: Editor): unknown => {
  const [snap, setSnap] = useState<unknown>(() => safeSnapshot(editor));
  useEffect(() => {
    const update = () => setSnap(safeSnapshot(editor));
    update();
    const unsub = editor.doc.subscribe(() => update());
    return () => unsub();
  }, [editor]);
  return snap;
};

const safeSnapshot = (editor: Editor): unknown => {
  try {
    return editor.doc.toJSON();
  } catch {
    return null;
  }
};
