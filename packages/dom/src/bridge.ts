import type { BlockId, Editor } from "@weaver/core";
import {
  TEXT_PLACEHOLDER,
  blockElementContaining,
  blockIdOf,
  findBlockElement,
  reconcileTopLevel,
} from "./dom-mapper.js";
import {
  type DomCaret,
  type DomRange,
  caretRect,
  placeCaret,
  readDomSelection,
  writeDomSelection,
} from "./selection-mapper.js";
import {
  type MentionTrigger,
  detectMentionTrigger,
  mentionTriggersEqual,
} from "./mention-trigger.js";
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

/**
 * Clipboard flavor carrying the structured weaver fragment (kinds, attrs,
 * marks, nesting) between weaver surfaces — specs/lexical-parity.md §3.
 * `text/plain` interoperates with everything else; HTML import/export is the
 * @weaver/plugins-html follow-up. Exported so tests and future plugins speak
 * the same protocol string.
 */
export const WEAVER_MIME = "application/x-weaver";

export interface BridgeOptions {
  readonly classList?: ReadonlyArray<string>;
  /**
   * Fired whenever the @-mention trigger state behind the caret changes —
   * `MentionTrigger` while the user is typing `@query`, `null` once the
   * trigger is dismissed (whitespace, caret move, deletion of the `@`).
   * Deduped: consecutive identical states notify once.
   */
  readonly onMentionTrigger?: (trigger: MentionTrigger | null) => void;
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

const richifyHost = (host: HTMLElement, opts: BridgeOptions, editable: boolean): void => {
  host.setAttribute("contenteditable", editable ? "true" : "false");
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
  richifyHost(host, options, editor.isEditable());
  reconcileTopLevel(editor, host);

  // Read-only mode (lexical-parity §3): mirror the core editable flag onto
  // `contenteditable` so the browser stops accepting input at the source; the
  // beforeinput/keydown guards below are the backstop for synthetic events.
  const unsubEditable = editor.onEditableChange(() => {
    host.setAttribute("contenteditable", editor.isEditable() ? "true" : "false");
  });

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
  // Whether a block's pre-reconcile DOM text matches the (already-committed)
  // model text. Guards the selection restore below: a DOM-captured offset is
  // only meaningful against unchanged text — re-applying it after a remote
  // insert/delete in the same block would relocate the caret relative to
  // what the user sees, which is worse than dropping it. Real cross-edit
  // stability needs Loro Cursor anchors (specs/hard-problems.md §1).
  const blockTextUnchanged = (blockId: BlockId): boolean => {
    const el = findBlockElement(host, blockId);
    if (!el) return false;
    const domText = (el.textContent ?? "").replaceAll(TEXT_PLACEHOLDER, "");
    return domText === editor.commands.text.read(blockId);
  };

  const flushRerender = (): void => {
    if (flushing) return;
    flushing = true;
    flushScheduled = false;
    try {
      // No pendingCaret (a remote/programmatic commit, not a local keystroke):
      // capture the live selection as model offsets before reconciling, then
      // write it back. Reconcile replaces marked runs via `replaceChildren`,
      // which would otherwise silently drop the user's caret whenever their
      // block carries marks. Restore only when the endpoint blocks' text is
      // unchanged (see blockTextUnchanged).
      let restore = pendingCaret;
      if (!restore) {
        const captured = readDomSelection(host);
        if (
          captured &&
          blockTextUnchanged(captured.anchor.blockId) &&
          (captured.anchor.blockId === captured.focus.blockId ||
            blockTextUnchanged(captured.focus.blockId))
        ) {
          restore = captured;
        }
      }
      reconcileTopLevel(editor, host);
      if (restore) writeDomSelection(host, restore);
      pendingCaret = null;
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

  // ---- @-mention trigger tracking -----------------------------------------
  let lastTrigger: MentionTrigger | null = null;

  /** Re-evaluate the trigger behind the caret; notify the host app on change. */
  const notifyMentionTrigger = (): void => {
    const notify = options.onMentionTrigger;
    if (!notify) return;
    let next: MentionTrigger | null = null;
    if (!composing) {
      const range = readDomSelection(host);
      if (range && range.collapsed) {
        const detected = detectMentionTrigger(editor, range.anchor);
        if (detected) {
          next = {
            ...detected,
            rect: caretRect(host, {
              blockId: detected.blockId,
              offset: detected.start,
            }),
          };
        }
      }
    }
    if (mentionTriggersEqual(lastTrigger, next)) return;
    lastTrigger = next;
    notify(next);
  };

  const onSelectionChange = (): void => {
    notifyMentionTrigger();
  };

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
    if (!editor.isEditable()) {
      // Read-only: swallow the input instead of letting the browser (or a
      // synthetic event) mutate the surface.
      ev.preventDefault();
      return;
    }
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
      notifyMentionTrigger();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    // Read-only: every shortcut below mutates the doc (indent, undo, marks,
    // clear-formatting) except Ctrl/Cmd+A, which is pure selection.
    if (!editor.isEditable()) {
      const lower = ev.key.toLowerCase();
      const isSelectAll = (ev.ctrlKey || ev.metaKey) && lower === "a";
      if (!isSelectAll) {
        ev.preventDefault();
        return;
      }
    }
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
      // Undo can restore (or remove) trigger text — re-evaluate, symmetric
      // with the Safari historyUndo beforeinput path.
      notifyMentionTrigger();
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
    // Read-only can flip MID-composition (programmatic toggle): beforeinput
    // is skipped while composing, so this is the only place the guard can
    // catch a finalized IME insert. contenteditable=false alone is not a
    // reliable IME suppressor across browsers.
    if (!editor.isEditable()) {
      composedTarget = null;
      composedInitial = "";
      flushRerender();
      return;
    }
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
    notifyMentionTrigger();
  };

  /** Snapshot the live DOM selection into the core selection state. */
  const syncSelectionFromDom = (): DomRange | null => {
    const range = readDomSelection(host);
    if (!range) return null;
    editor.commands.selection.set(range);
    return range;
  };

  const writeClipboard = (ev: ClipboardEvent, cutting: boolean): void => {
    if (!ev.clipboardData) return;
    if (!syncSelectionFromDom()) return;
    const payload = cutting
      ? editor.commands.clipboard.cut()
      : editor.commands.clipboard.copy();
    if (!payload) return;
    // The browser default would serialize the DOM selection itself —
    // preventDefault so the model-derived payload is authoritative.
    ev.preventDefault();
    ev.clipboardData.setData("text/plain", payload.text);
    ev.clipboardData.setData(WEAVER_MIME, JSON.stringify(payload));
    if (cutting) {
      const sel = editor.commands.selection.get();
      if (sel) {
        pendingCaret = { anchor: sel.anchor, focus: sel.anchor, collapsed: true };
      }
      flushRerender();
    }
  };

  const onCopy = (ev: Event): void => writeClipboard(ev as ClipboardEvent, false);
  const onCut = (ev: Event): void => writeClipboard(ev as ClipboardEvent, true);

  const onPaste = (ev: Event): void => {
    const e = ev as ClipboardEvent;
    if (!e.clipboardData) return;
    // Always claim the paste: LoroDoc is the single source of truth (D1), so
    // the browser must never splice clipboard HTML into the DOM directly.
    e.preventDefault();
    if (!syncSelectionFromDom()) return;
    const structured = e.clipboardData.getData(WEAVER_MIME);
    try {
      if (structured) {
        try {
          editor.commands.clipboard.paste(JSON.parse(structured));
        } catch {
          // Corrupt flavor (e.g. truncated by another app) — fall back to text.
          editor.commands.clipboard.pasteText(
            e.clipboardData.getData("text/plain") ?? "",
          );
        }
      } else {
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        editor.commands.clipboard.pasteText(text);
      }
    } catch {
      // The fallback itself can throw (e.g. caret programmatically placed on
      // a non-inline block) — an unhandled exception from a DOM event
      // listener helps no one; the paste is simply dropped.
      return;
    }
    const sel = editor.commands.selection.get();
    if (sel) {
      pendingCaret = { anchor: sel.anchor, focus: sel.anchor, collapsed: true };
    }
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
  host.addEventListener("copy", onCopy);
  host.addEventListener("cut", onCut);
  host.addEventListener("paste", onPaste);
  // Caret moves (arrow keys, clicks) don't go through beforeinput — the
  // document-level selectionchange event is what dismisses / re-opens the
  // mention trigger on pure caret motion.
  if (options.onMentionTrigger) {
    host.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    // Scroll (capture: catches nested scrollers) and resize move the trigger's
    // viewport rect without any selection change — re-anchor the picker.
    host.ownerDocument.addEventListener("scroll", onSelectionChange, true);
    host.ownerDocument.defaultView?.addEventListener(
      "resize",
      onSelectionChange,
    );
  }

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
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("cut", onCut);
      host.removeEventListener("paste", onPaste);
      if (options.onMentionTrigger) {
        host.ownerDocument.removeEventListener(
          "selectionchange",
          onSelectionChange,
        );
        host.ownerDocument.removeEventListener(
          "scroll",
          onSelectionChange,
          true,
        );
        host.ownerDocument.defaultView?.removeEventListener(
          "resize",
          onSelectionChange,
        );
      }
      host.removeAttribute("contenteditable");
      host.removeAttribute("data-weaver-root");
      unsubEditable();
      unsub();
    },
  };
};
