import type { BlockId, Editor } from "@weaver/core";
import { TEXT_PLACEHOLDER, blockElementContaining, blockIdOf, findBlockElement } from "./dom-mapper.js";

export interface DomCaret {
  readonly blockId: BlockId;
  readonly offset: number;
}

export interface DomRange {
  readonly anchor: DomCaret;
  readonly focus: DomCaret;
  readonly collapsed: boolean;
}

const textOffsetWithin = (el: HTMLElement, node: Node, offset: number): number => {
  if (node === el) {
    let count = 0;
    for (let i = 0; i < offset; i++) {
      const child = el.childNodes[i];
      if (child) count += (child.textContent ?? "").length;
    }
    return count;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t === node) return total + Math.min(offset, t.length);
    total += t.length;
  }
  return total;
};

const caretFromDom = (
  host: HTMLElement,
  node: Node | null,
  offset: number,
): DomCaret | null => {
  const blockEl = blockElementContaining(host, node);
  if (!blockEl) return null;
  const id = blockIdOf(blockEl);
  if (!id) return null;
  const raw = textOffsetWithin(blockEl, node!, offset);
  const text = blockEl.textContent ?? "";
  const isPlaceholder = text === TEXT_PLACEHOLDER;
  const corrected = isPlaceholder ? 0 : raw;
  return { blockId: id, offset: corrected };
};

export const readDomSelection = (host: HTMLElement): DomRange | null => {
  const sel = host.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  if (!sel.anchorNode || !sel.focusNode) return null;
  if (!host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) return null;
  const anchor = caretFromDom(host, sel.anchorNode, sel.anchorOffset);
  const focus = caretFromDom(host, sel.focusNode, sel.focusOffset);
  if (!anchor || !focus) return null;
  return {
    anchor,
    focus,
    collapsed: anchor.blockId === focus.blockId && anchor.offset === focus.offset,
  };
};

const findTextNode = (
  el: HTMLElement,
  offset: number,
): { node: Text | HTMLElement; offset: number } => {
  if ((el.textContent ?? "") === TEXT_PLACEHOLDER) {
    // empty block; caret at 0
    const first = el.firstChild;
    if (first instanceof Text) return { node: first, offset: 0 };
    return { node: el, offset: 0 };
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    last = t;
    if (remaining <= t.length) return { node: t, offset: remaining };
    remaining -= t.length;
  }
  if (last) return { node: last, offset: last.length };
  return { node: el, offset: 0 };
};

export const writeDomSelection = (
  host: HTMLElement,
  range: DomRange,
): void => {
  const sel = host.ownerDocument.getSelection();
  if (!sel) return;
  const aEl = findBlockElement(host, range.anchor.blockId);
  const fEl = findBlockElement(host, range.focus.blockId);
  if (!aEl || !fEl) return;
  const a = findTextNode(aEl, range.anchor.offset);
  const f = findTextNode(fEl, range.focus.offset);
  const r = host.ownerDocument.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(f.node, f.offset);
  sel.removeAllRanges();
  sel.addRange(r);
};

export const placeCaret = (host: HTMLElement, caret: DomCaret): void => {
  writeDomSelection(host, { anchor: caret, focus: caret, collapsed: true });
};

export const computeMarkRangeWithinBlock = (
  editor: Editor,
  range: DomRange,
): { blockId: BlockId; start: number; end: number } | null => {
  if (range.anchor.blockId !== range.focus.blockId) return null;
  const start = Math.min(range.anchor.offset, range.focus.offset);
  const end = Math.max(range.anchor.offset, range.focus.offset);
  if (start === end) {
    const len = editor.commands.text.length(range.anchor.blockId);
    return { blockId: range.anchor.blockId, start: 0, end: len };
  }
  return { blockId: range.anchor.blockId, start, end };
};
