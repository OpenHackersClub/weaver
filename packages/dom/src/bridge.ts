import type { BlockId, Editor } from "@weaver/core";
import { blockElementContaining, blockIdOf, reconcileTopLevel } from "./dom-mapper.js";
import {
  type DomCaret,
  type DomRange,
  placeCaret,
  readDomSelection,
  writeDomSelection,
} from "./selection-mapper.js";
import {
  handleBackspace,
  handleClearFormatting,
  handleDeleteForward,
  handleEnter,
  handleInsertLineBreak,
  handleInsertText,
  handleLineBackspace,
  handleLineDeleteForward,
  handleToggleMark,
  handleWordBackspace,
  handleWordDeleteForward,
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

// Delete a non-collapsed selection — single- or cross-block — and return the
// resulting collapsed caret. Routes through the core `selection` command,
// which deletes each spanned block's covered text and merges the trailing
// blocks into the anchor (mirroring Lexical's $insertText on a range). The DOM
// layer must not reinvent that merge; the previous single-block-only guard let
// a cross-block Backspace / type-over (e.g. after Cmd+A) silently no-op.
const deleteDomRange = (editor: Editor, range: DomRange): DomCaret => {
  editor.commands.selection.set(range);
  editor.commands.selection.deleteRange();
  const sel = editor.commands.selection.get();
  return sel ? sel.anchor : range.anchor;
};

const richifyHost = (host: HTMLElement, opts: BridgeOptions): void => {
  host.setAttribute("contenteditable", "true");
  host.setAttribute("data-weaver-root", "");
  host.setAttribute("spellcheck", "true");
  host.setAttribute("role", "textbox");
  host.setAttribute("aria-multiline", "true");
  // Render LoroDoc text verbatim. The browser default `white-space: normal`
  // collapses runs of spaces and trims trailing spaces at a line's end, so a
  // user typing two spaces — or a space ending a sentence — would see the
  // editor silently swallow them even though LoroDoc stored them faithfully.
  // `pre-wrap` preserves every space and still wraps long lines; it's a
  // functional requirement of the editing surface, hence set here, not in CSS.
  host.style.whiteSpace = "pre-wrap";
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
  // The block most recently targeted by Tab/Shift+Tab. An indent nests the
  // block under a sibling, and `reconcileTopLevel` only renders top-level
  // blocks — so the nested element leaves the DOM and the live selection
  // with it. Tracking the id lets a follow-up Shift+Tab still target it.
  let lastIndentTarget: BlockId | null = null;
  let composing = false;
  let composedTarget: { blockId: string; offset: number } | null = null;
  let composedInitial = "";

  let flushScheduled = false;
  let flushing = false;

  // Reconcile DOM to current LoroDoc state and write back any caret set by the
  // last operation. Synchronous so the local-edit path can call it after each
  // beforeinput — without that, multiple synchronous beforeinput events
  // (macOS autocorrect, IME, scripted bursts) all read the same stale DOM
  // selection at offset 0 and the chars come out reversed ("hello" → "olleh").
  // Idempotent and re-entrancy guarded so doc.subscribe can call it safely too.
  const flushRerender = (): void => {
    if (flushing) return;
    flushing = true;
    flushScheduled = false;
    try {
      reconcileTopLevel(editor, host);
      if (pendingCaret) {
        writeDomSelection(host, pendingCaret);
        pendingCaret = null;
      }
    } finally {
      flushing = false;
    }
  };

  const rerender = (): void => flushRerender();

  // For remote / agent changes coming through doc.subscribe: dedupe via
  // microtask so a burst of commits triggers a single reconcile.
  const scheduleRerender = (): void => {
    if (flushScheduled || flushing) return;
    flushScheduled = true;
    queueMicrotask(() => {
      if (!flushScheduled) return;
      flushRerender();
    });
  };

  const unsub = editor.doc.subscribe(() => {
    scheduleRerender();
  });

  const applyBeforeInput = (e: InputEvent): void => {
    let range = readDomSelection(host);
    if (!range) {
      ensureCaretInBlock(editor, host);
      range = readDomSelection(host);
      if (!range) return;
    }
    const inputType = e.inputType;

    // Insert family. The OS-level intent here is always "place this text at the
    // caret, replacing any non-collapsed selection." The variants differ only
    // in *where* the text comes from (typing, paste, drop, yank, autocorrect)
    // — and where the browser stuffs it on the event. `insertText` /
    // `insertReplacementText` put the string in `e.data`; clipboard/drag-source
    // variants may instead populate `e.dataTransfer`. Either is fine because
    // the model op is the same.
    if (
      inputType === "insertText" ||
      inputType === "insertReplacementText" ||
      inputType === "insertFromPaste" ||
      inputType === "insertFromPasteAsQuotation" ||
      inputType === "insertFromDrop" ||
      inputType === "insertFromYank" ||
      inputType === "insertFromComposition"
    ) {
      let data = e.data ?? "";
      if (data.length === 0 && e.dataTransfer) {
        data = e.dataTransfer.getData("text/plain") ?? "";
      }
      if (data.length === 0) return;
      // A non-collapsed selection — single- or cross-block — is type-over:
      // delete it first, then insert at the resulting collapsed caret.
      const baseCaret = range.collapsed ? range.anchor : deleteDomRange(editor, range);
      const res = handleInsertText(editor, baseCaret, data);
      pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    if (inputType === "insertParagraph") {
      const res = handleEnter(editor, range.anchor);
      pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }
    if (inputType === "insertLineBreak") {
      // Soft line break — insert a "\n" into the current block's text; never
      // create a new block. specs/lexical-parity.md §1 LineBreakNode.
      const res = handleInsertLineBreak(editor, range.anchor);
      pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }

    // Backwards-delete family. macOS / Chromium emit a different `inputType`
    // for each granularity (char / word / visual-line); we translate each into
    // the matching keymap handler. A non-collapsed selection short-circuits
    // every granularity — the OS-level intent is just "remove the selection."
    if (
      inputType === "deleteContentBackward" ||
      inputType === "deleteWordBackward" ||
      inputType === "deleteSoftLineBackward" ||
      inputType === "deleteHardLineBackward"
    ) {
      if (!range.collapsed) {
        const caret = deleteDomRange(editor, range);
        pendingCaret = { anchor: caret, focus: caret, collapsed: true };
        return;
      }
      const handler =
        inputType === "deleteWordBackward"
          ? handleWordBackspace
          : inputType === "deleteSoftLineBackward" ||
              inputType === "deleteHardLineBackward"
            ? handleLineBackspace
            : handleBackspace;
      const res = handler(editor, range.anchor);
      if (res) pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }

    // Forwards-delete family — symmetric to the backwards variants above.
    if (
      inputType === "deleteContentForward" ||
      inputType === "deleteWordForward" ||
      inputType === "deleteSoftLineForward" ||
      inputType === "deleteHardLineForward"
    ) {
      if (!range.collapsed) {
        const caret = deleteDomRange(editor, range);
        pendingCaret = { anchor: caret, focus: caret, collapsed: true };
        return;
      }
      const handler =
        inputType === "deleteWordForward"
          ? handleWordDeleteForward
          : inputType === "deleteSoftLineForward" ||
              inputType === "deleteHardLineForward"
            ? handleLineDeleteForward
            : handleDeleteForward;
      const res = handler(editor, range.anchor);
      if (res) pendingCaret = { anchor: res.caret, focus: res.caret, collapsed: true };
      return;
    }

    // Cut / drag-source / composition-replace. The browser has already done
    // its half — `cut` populated the clipboard (we don't preventDefault `cut`),
    // `dragstart` populated `dataTransfer`, IME finalized composition — and
    // now signals "remove the corresponding range from the model." Equivalent
    // to deleting a non-collapsed selection.
    if (
      inputType === "deleteByCut" ||
      inputType === "deleteByDrag" ||
      inputType === "deleteByComposition"
    ) {
      if (!range.collapsed) {
        const caret = deleteDomRange(editor, range);
        pendingCaret = { anchor: caret, focus: caret, collapsed: true };
      }
      return;
    }

    // Safari delivers Cmd+Z / Cmd+Shift+Z to contenteditable as a beforeinput
    // event rather than (only) as a keydown. Wire both signals to the same
    // Loro `UndoManager` so Safari undo doesn't silently miss when the user
    // initiates undo before any keydown reaches our handler.
    if (inputType === "historyUndo") {
      editor.commands.history.undo();
      return;
    }
    if (inputType === "historyRedo") {
      editor.commands.history.redo();
      return;
    }

    // Unknown / unsupported inputType: already preventDefault'd above.
  };

  const onBeforeInput = (ev: Event): void => {
    if (composing) return;
    const e = ev as InputEvent;
    // LoroDoc is the single source of truth (D1); never let the browser
    // mutate the DOM out-of-band.
    e.preventDefault();
    try {
      applyBeforeInput(e);
    } finally {
      // Flush synchronously so the DOM selection is up to date before the
      // next beforeinput event reads it. See flushRerender() for why this
      // can't wait for a microtask.
      flushRerender();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    // Tab / Shift+Tab — indent / outdent the current block. No modifier
    // required, so handle it before the modifier early-return below.
    if (ev.key === "Tab") {
      ev.preventDefault();
      const range = readDomSelection(host);
      const blockId = range?.anchor.blockId ?? lastIndentTarget;
      if (blockId) {
        if (ev.shiftKey) editor.commands.block.outdent({ blockId });
        else editor.commands.block.indent({ blockId });
        lastIndentTarget = blockId;
        flushRerender();
      }
      return;
    }

    const modKey = ev.ctrlKey || ev.metaKey;
    if (!modKey) return;
    const lower = ev.key.toLowerCase();

    // Ctrl/Cmd+Z — undo; Ctrl/Cmd+Shift+Z — redo.
    if (lower === "z") {
      ev.preventDefault();
      if (ev.shiftKey) editor.commands.history.redo();
      else editor.commands.history.undo();
      flushRerender();
      return;
    }

    // Ctrl/Cmd+A — select from the start of the first block to the end of
    // the last. The doc is unchanged, so no rerender.
    if (lower === "a") {
      ev.preventDefault();
      const blocks = Array.from(
        host.querySelectorAll("[data-block-id]"),
      ) as HTMLElement[];
      const firstId = blocks[0] ? blockIdOf(blocks[0]) : null;
      const lastEl = blocks[blocks.length - 1];
      const lastId = lastEl ? blockIdOf(lastEl) : null;
      if (firstId && lastId) {
        const lastLen = editor.commands.text.length(lastId);
        writeDomSelection(host, {
          anchor: { blockId: firstId, offset: 0 },
          focus: { blockId: lastId, offset: lastLen },
          collapsed: false,
        });
      }
      return;
    }

    // Ctrl/Cmd+\ — strip all inline formatting from the selection.
    if (lower === "\\") {
      ev.preventDefault();
      const range = readDomSelection(host);
      if (range) {
        handleClearFormatting(editor, range);
        pendingCaret = range;
        flushRerender();
      }
      return;
    }

    const mark = MARK_FROM_KEY[lower];
    if (!mark) return;
    ev.preventDefault();
    const range = readDomSelection(host);
    if (!range) return;
    handleToggleMark(editor, range, mark);
    pendingCaret = range;
    flushRerender();
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
    flushRerender();
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
