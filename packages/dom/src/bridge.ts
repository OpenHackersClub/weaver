import type { BlockId, Editor } from "@weaver/core";
import { blockElementContaining, blockIdOf, reconcileTopLevel } from "./dom-mapper.js";
import {
  type DomRange,
  placeCaret,
  readDomSelection,
  writeDomSelection,
} from "./selection-mapper.js";
import {
  handleBackspace,
  handleDeleteForward,
  handleEnter,
  handleInsertText,
  handleToggleMark,
} from "./keymap.js";

export interface BridgeOptions {
  readonly classList?: ReadonlyArray<string>;
}

export interface AttachedBridge {
  readonly host: HTMLElement;
  rerender(): void;
  detach(): void;
}

const MARK_FROM_KEY: Record<string, "bold" | "italic" | "underline" | "strike"> = {
  b: "bold",
  i: "italic",
  u: "underline",
};

const richifyHost = (host: HTMLElement, opts: BridgeOptions): void => {
  host.setAttribute("contenteditable", "true");
  host.setAttribute("data-weaver-root", "");
  host.setAttribute("spellcheck", "true");
  host.setAttribute("role", "textbox");
  host.setAttribute("aria-multiline", "true");
  host.classList.add("weaver-host");
  for (const c of opts.classList ?? []) host.classList.add(c);
};

const findClosestBlockForPoint = (
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { id: BlockId; placeAtEnd: boolean } | null => {
  const blocks = Array.from(host.querySelectorAll("[data-block-id]")) as HTMLElement[];
  if (blocks.length === 0) return null;
  let best: { el: HTMLElement; dist: number } | null = null;
  for (const el of blocks) {
    const rect = el.getBoundingClientRect();
    const cx = Math.max(rect.left, Math.min(clientX, rect.right));
    const cy = Math.max(rect.top, Math.min(clientY, rect.bottom));
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (best === null || dist < best.dist) best = { el, dist };
  }
  if (!best) return null;
  const id = blockIdOf(best.el);
  if (!id) return null;
  const rect = best.el.getBoundingClientRect();
  const placeAtEnd = clientY > rect.bottom;
  return { id, placeAtEnd };
};

const ensureCaretInBlock = (
  editor: Editor,
  host: HTMLElement,
  preferred?: { x: number; y: number },
): void => {
  const sel = host.ownerDocument.getSelection();
  if (sel && sel.rangeCount > 0 && sel.anchorNode && host.contains(sel.anchorNode)) {
    const within = blockElementContaining(host, sel.anchorNode);
    if (within) return;
  }
  let target: { id: BlockId; placeAtEnd: boolean } | null = null;
  if (preferred) {
    target = findClosestBlockForPoint(host, preferred.x, preferred.y);
  }
  if (!target) {
    const blocks = host.querySelectorAll("[data-block-id]");
    const fallback = blocks[blocks.length - 1] as HTMLElement | undefined;
    const id = fallback ? blockIdOf(fallback) : null;
    if (!id) return;
    target = { id, placeAtEnd: true };
  }
  const offset = target.placeAtEnd ? editor.commands.text.length(target.id) : 0;
  placeCaret(host, { blockId: target.id, offset });
};

export const attachEditor = (
  editor: Editor,
  host: HTMLElement,
  options: BridgeOptions = {},
): AttachedBridge => {
  richifyHost(host, options);
  reconcileTopLevel(editor, host);

  let pendingCaret: DomRange | null = null;
  let composing = false;
  let composedTarget: { blockId: string; offset: number } | null = null;
  let composedInitial = "";

  const rerender = (): void => {
    reconcileTopLevel(editor, host);
    if (pendingCaret) {
      writeDomSelection(host, pendingCaret);
      pendingCaret = null;
    }
  };

  const unsub = editor.doc.subscribe(() => {
    queueMicrotask(rerender);
  });

  const onBeforeInput = (ev: Event): void => {
    if (composing) return;
    const e = ev as InputEvent;
    // Always prevent default: the LoroDoc is the single source of truth (D1).
    // Letting the browser mutate the DOM out-of-band would drift it from the doc.
    e.preventDefault();
    let range = readDomSelection(host);
    if (!range) {
      ensureCaretInBlock(editor, host);
      range = readDomSelection(host);
      if (!range) return;
    }
    const inputType = e.inputType;
    if (
      inputType === "insertText" ||
      inputType === "insertReplacementText" ||
      inputType === "insertFromPaste"
    ) {
      const data = e.data ?? "";
      if (data.length === 0) return;
      // If selection is non-collapsed, delete the range first (single-block only for MVP).
      if (!range.collapsed && range.anchor.blockId === range.focus.blockId) {
        const start = Math.min(range.anchor.offset, range.focus.offset);
        const end = Math.max(range.anchor.offset, range.focus.offset);
        if (end > start) {
          editor.commands.text.delete({
            blockId: range.anchor.blockId,
            offset: start,
            length: end - start,
          });
        }
        const baseCaret = { blockId: range.anchor.blockId, offset: start };
        const res = handleInsertText(editor, baseCaret, data);
        pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      } else {
        const res = handleInsertText(editor, range.anchor, data);
        pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      }
      return;
    }
    if (inputType === "insertParagraph") {
      const res = handleEnter(editor, range.anchor);
      pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    if (inputType === "insertLineBreak") {
      // For now treat as insertParagraph (block split). Soft-break is post-MVP.
      const res = handleEnter(editor, range.anchor);
      pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    if (inputType === "deleteContentBackward" || inputType === "deleteWordBackward") {
      if (!range.collapsed && range.anchor.blockId === range.focus.blockId) {
        const start = Math.min(range.anchor.offset, range.focus.offset);
        const end = Math.max(range.anchor.offset, range.focus.offset);
        editor.commands.text.delete({
          blockId: range.anchor.blockId,
          offset: start,
          length: end - start,
        });
        pendingCaret = {
          anchor: { blockId: range.anchor.blockId, offset: start },
          focus: { blockId: range.anchor.blockId, offset: start },
          collapsed: true,
        };
        return;
      }
      const res = handleBackspace(editor, range.anchor);
      if (res) pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    if (inputType === "deleteContentForward" || inputType === "deleteWordForward") {
      if (!range.collapsed && range.anchor.blockId === range.focus.blockId) {
        const start = Math.min(range.anchor.offset, range.focus.offset);
        const end = Math.max(range.anchor.offset, range.focus.offset);
        editor.commands.text.delete({
          blockId: range.anchor.blockId,
          offset: start,
          length: end - start,
        });
        pendingCaret = {
          anchor: { blockId: range.anchor.blockId, offset: start },
          focus: { blockId: range.anchor.blockId, offset: start },
          collapsed: true,
        };
        return;
      }
      const res = handleDeleteForward(editor, range.anchor);
      if (res) pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    // Unknown / unsupported inputType: already preventDefault'd above.
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    const modKey = ev.ctrlKey || ev.metaKey;
    if (!modKey) return;
    const lower = ev.key.toLowerCase();
    const mark = MARK_FROM_KEY[lower];
    if (!mark) return;
    ev.preventDefault();
    const range = readDomSelection(host);
    if (!range) return;
    handleToggleMark(editor, range, mark);
    pendingCaret = range;
  };

  const onCompositionStart = (): void => {
    const range = readDomSelection(host);
    if (!range || !range.collapsed) {
      composedTarget = null;
      composedInitial = "";
    } else {
      composedTarget = { ...range.anchor };
      composedInitial = "";
    }
    composing = true;
  };

  const onCompositionEnd = (ev: CompositionEvent): void => {
    composing = false;
    const final = ev.data ?? "";
    if (composedTarget && final.length > 0) {
      editor.commands.text.insert({
        blockId: composedTarget.blockId,
        offset: composedTarget.offset + composedInitial.length,
        value: final,
      });
      pendingCaret = {
        anchor: {
          blockId: composedTarget.blockId,
          offset: composedTarget.offset + composedInitial.length + final.length,
        },
        focus: {
          blockId: composedTarget.blockId,
          offset: composedTarget.offset + composedInitial.length + final.length,
        },
        collapsed: true,
      };
    }
    composedTarget = null;
    composedInitial = "";
  };

  const onFocus = (): void => {
    ensureCaretInBlock(editor, host);
  };

  const onMouseDown = (ev: MouseEvent): void => {
    // If the click lands directly on the host (outside any block element)
    // intercept it: focus the host ourselves and place the caret inside the
    // nearest block. Without this the browser leaves the caret at the host
    // root and our beforeinput selection-mapping fails.
    if (ev.target !== host) return;
    ev.preventDefault();
    host.focus({ preventScroll: true });
    ensureCaretInBlock(editor, host, { x: ev.clientX, y: ev.clientY });
  };

  host.addEventListener("beforeinput", onBeforeInput as EventListener);
  host.addEventListener("keydown", onKeyDown);
  host.addEventListener("compositionstart", onCompositionStart);
  host.addEventListener("compositionend", onCompositionEnd);
  host.addEventListener("focus", onFocus);
  host.addEventListener("mousedown", onMouseDown);

  return {
    host,
    rerender,
    detach: () => {
      host.removeEventListener("beforeinput", onBeforeInput as EventListener);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("compositionstart", onCompositionStart);
      host.removeEventListener("compositionend", onCompositionEnd);
      host.removeEventListener("focus", onFocus);
      host.removeEventListener("mousedown", onMouseDown);
      host.removeAttribute("contenteditable");
      host.removeAttribute("data-weaver-root");
      unsub();
    },
  };
};
