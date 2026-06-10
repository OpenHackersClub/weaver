import type { BlockId, BlockKind, Editor } from "@weaver/core";
import { getBlock, getChildren, rootId } from "@weaver/core";
import { Match } from "effect";
import { documentOrderWithDepth } from "./dom-mapper.js";
import {
  type DomCaret,
  type DomRange,
  computeMarkRangeWithinBlock,
} from "./selection-mapper.js";

export type IntendedCaret = DomCaret;

export interface ApplyResult {
  readonly caret: IntendedCaret;
}

/** Parent of `id` in the block tree — ROOT for top-level blocks, null if missing. */
const findParent = (editor: Editor, id: BlockId): BlockId | null => {
  const walk = (parentId: BlockId): BlockId | null => {
    for (const child of getChildren(editor, parentId)) {
      if (child === id) return parentId;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(rootId(editor));
};

// Backspace/Delete at a block edge operate on the *visually adjacent* line.
// The DOM renders blocks flat in document order, so that neighbour is the
// document-order predecessor/successor — which, with nesting, is not always
// a sibling (e.g. the predecessor of a top-level block can be the deepest
// descendant of the previous top-level block).
const docOrderNeighbor = (
  editor: Editor,
  id: BlockId,
  delta: -1 | 1,
): BlockId | null => {
  const order = documentOrderWithDepth(editor);
  const i = order.findIndex((entry) => entry.id === id);
  if (i < 0) return null;
  return order[i + delta]?.id ?? null;
};

/** Insert a fresh paragraph right after `blockId` and return its id. */
const insertParagraphAfter = (editor: Editor, blockId: BlockId): BlockId => {
  const parent = findParent(editor, blockId) ?? rootId(editor);
  const index = getChildren(editor, parent).indexOf(blockId) + 1;
  return editor.commands.block.insert({
    parentId: parent,
    index,
    kind: "paragraph",
  });
};

export const handleInsertText = (
  editor: Editor,
  caret: DomCaret,
  value: string,
): ApplyResult => {
  // Typing with the caret on a block that has no inline text (divider, image,
  // embed) cannot insert there — `text.insert` would throw. Notion's behavior:
  // the text starts a new paragraph below the block.
  const target = getBlock(editor, caret.blockId);
  if (target && !target.hasInline) {
    const newId = insertParagraphAfter(editor, caret.blockId);
    editor.commands.text.insert({ blockId: newId, offset: 0, value });
    return { caret: { blockId: newId, offset: value.length } };
  }
  editor.commands.text.insert({
    blockId: caret.blockId,
    offset: caret.offset,
    value,
  });
  const newCaret: DomCaret = { blockId: caret.blockId, offset: caret.offset + value.length };
  const shortcutCaret = maybeApplyMarkdownShortcut(editor, newCaret);
  return { caret: shortcutCaret ?? latestCaret(editor, caret, newCaret) };
};

const latestCaret = (editor: Editor, prev: DomCaret, candidate: DomCaret): DomCaret => {
  const block = getBlock(editor, candidate.blockId);
  if (!block) {
    // block was transformed/replaced; find current first block
    const kids = getChildren(editor, rootId(editor));
    const first = kids[0];
    if (!first) return candidate;
    return { blockId: first, offset: 0 };
  }
  const len = editor.commands.text.length(candidate.blockId);
  return { blockId: candidate.blockId, offset: Math.min(candidate.offset, len) };
};

const MARKDOWN_HEADING = /^(#{1,6}) $/;
const MARKDOWN_NUMBERED = /^\d+\. $/;

interface InlineShortcut {
  readonly re: RegExp;
  readonly mark: "bold" | "italic" | "strike" | "code";
}

// Trailing-space inline-delimiter shortcuts. Each captures the inner text.
const INLINE_SHORTCUTS: ReadonlyArray<InlineShortcut> = [
  { re: /\*\*([^*\n]+)\*\* $/, mark: "bold" },
  { re: /_([^_\n]+)_ $/, mark: "italic" },
  { re: /~~([^~\n]+)~~ $/, mark: "strike" },
  { re: /`([^`\n]+)` $/, mark: "code" },
];

const applyInlineShortcut = (editor: Editor, caret: DomCaret): boolean => {
  const text = editor.commands.text.read(caret.blockId);
  for (const { re, mark } of INLINE_SHORTCUTS) {
    const m = re.exec(text);
    if (!m) continue;
    const inner = m[1] ?? "";
    const matchStart = m.index;
    const matchLen = m[0].length;
    editor.commands.text.delete({
      blockId: caret.blockId,
      offset: matchStart,
      length: matchLen,
    });
    editor.commands.text.insert({
      blockId: caret.blockId,
      offset: matchStart,
      value: `${inner} `,
    });
    editor.commands.text.toggleMark({
      blockId: caret.blockId,
      range: { start: matchStart, end: matchStart + inner.length },
      mark,
    });
    return true;
  }
  return false;
};

/**
 * Apply a block-level or inline markdown shortcut if the block's text matches
 * one. Returns a caret override when the transform moves the caret somewhere
 * the plain insert-position arithmetic can't know about (currently only the
 * divider, which has no inline text to put a caret in).
 */
const maybeApplyMarkdownShortcut = (
  editor: Editor,
  caret: DomCaret,
): DomCaret | null => {
  const block = getBlock(editor, caret.blockId);
  if (!block) return null;
  if (block.kind !== "paragraph") return null;
  const text = editor.commands.text.read(caret.blockId);

  const transformBlock = (
    consumed: number,
    newKind: BlockKind,
    attrs: Record<string, unknown> = {},
  ): void => {
    if (consumed > 0) {
      editor.commands.text.delete({
        blockId: caret.blockId,
        offset: 0,
        length: consumed,
      });
    }
    editor.commands.block.transform({
      blockId: caret.blockId,
      newKind,
      attrs,
    });
  };

  // Headings — `# `..`###### `.
  const heading = MARKDOWN_HEADING.exec(text);
  if (heading) {
    const hashes = heading[1] ?? "";
    const level = Math.max(1, Math.min(6, hashes.length)) as 1 | 2 | 3 | 4 | 5 | 6;
    transformBlock(hashes.length + 1, "heading", { level });
    return null;
  }

  // Divider — check before bullet (`*** ` must not be read as `* `). A
  // divider has no inline text, so the caret can't stay in the transformed
  // block: continue in a fresh paragraph below (Notion's behavior).
  if (text === "--- " || text === "*** ") {
    transformBlock(4, "divider");
    const newId = insertParagraphAfter(editor, caret.blockId);
    return { blockId: newId, offset: 0 };
  }

  // Code fence — 3 backticks + space.
  if (text === "``` ") {
    transformBlock(4, "code");
    return null;
  }

  // Quote.
  if (text === "> ") {
    transformBlock(2, "quote");
    return null;
  }

  // Bullet list — `- ` or `* `.
  if (text === "- " || text === "* ") {
    transformBlock(2, "bullet-list-item");
    return null;
  }

  // Numbered list — `\d+. `.
  if (MARKDOWN_NUMBERED.test(text)) {
    transformBlock(text.length, "numbered-list-item");
    return null;
  }

  // To-do — `[ ] ` / `[x] ` / `[X] `.
  if (text === "[ ] ") {
    transformBlock(4, "to-do", { checked: false });
    return null;
  }
  if (text === "[x] " || text === "[X] ") {
    transformBlock(4, "to-do", { checked: true });
    return null;
  }

  // No block-level transform fired — try inline delimiter shortcuts.
  applyInlineShortcut(editor, caret);
  return null;
};

export const handleInsertLineBreak = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult => {
  editor.commands.text.insert({
    blockId: caret.blockId,
    offset: caret.offset,
    value: "\n",
  });
  return { caret: { blockId: caret.blockId, offset: caret.offset + 1 } };
};

const LIST_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  "bullet-list-item",
  "numbered-list-item",
  "to-do",
]);

export const handleEnter = (editor: Editor, caret: DomCaret): ApplyResult => {
  // Enter on an *empty* list item exits the list — the item becomes a plain
  // paragraph rather than spawning another empty list item.
  const block = getBlock(editor, caret.blockId);
  if (
    block &&
    LIST_KINDS.has(block.kind) &&
    editor.commands.text.length(caret.blockId) === 0
  ) {
    editor.commands.block.transform({
      blockId: caret.blockId,
      newKind: "paragraph",
      attrs: {},
    });
    return { caret: { blockId: caret.blockId, offset: 0 } };
  }
  // Captured before the split — afterwards the head block's length always
  // equals `caret.offset`, so "was the caret at the end?" must be read first.
  const atEnd = caret.offset >= editor.commands.text.length(caret.blockId);
  const newId = editor.commands.block.split({
    blockId: caret.blockId,
    offset: caret.offset,
  });
  // Enter at the END of a heading or quote starts a plain paragraph — only a
  // mid-block split carries the kind into the tail (Lexical's
  // `insertNewAfter`; Notion behaves the same). List items keep continuing.
  if (block && (block.kind === "heading" || block.kind === "quote") && atEnd) {
    editor.commands.block.transform({
      blockId: newId,
      newKind: "paragraph",
      attrs: {},
    });
  }
  return { caret: { blockId: newId, offset: 0 } };
};

export const handleBackspace = (editor: Editor, caret: DomCaret): ApplyResult | null => {
  const block = getBlock(editor, caret.blockId);
  // Caret sitting on a block with no inline text (divider, image, embed):
  // Backspace removes the block itself — merging would throw.
  if (block && !block.hasInline) {
    const prev = docOrderNeighbor(editor, caret.blockId, -1);
    editor.commands.block.delete({ blockId: caret.blockId });
    if (prev) {
      return { caret: { blockId: prev, offset: editor.commands.text.length(prev) } };
    }
    const first = getChildren(editor, rootId(editor))[0];
    return first ? { caret: { blockId: first, offset: 0 } } : null;
  }
  if (caret.offset > 0) {
    editor.commands.text.delete({
      blockId: caret.blockId,
      offset: caret.offset - 1,
      length: 1,
    });
    return { caret: { blockId: caret.blockId, offset: caret.offset - 1 } };
  }
  // offset === 0 on a nested block — lift it one level before any merge
  // (Notion: the first Backspace at the start of an indented block outdents).
  const parent = findParent(editor, caret.blockId);
  if (parent && parent !== rootId(editor)) {
    editor.commands.block.outdent({ blockId: caret.blockId });
    return { caret };
  }
  const prev = docOrderNeighbor(editor, caret.blockId, -1);
  if (!prev) {
    // first block, offset 0 — if heading/list/quote, demote to paragraph
    if (block && block.kind !== "paragraph") {
      editor.commands.block.transform({
        blockId: caret.blockId,
        newKind: "paragraph",
        attrs: {},
      });
      return { caret };
    }
    return null;
  }
  const prevBlock = getBlock(editor, prev);
  if (prevBlock && !prevBlock.hasInline) {
    // The visually-previous line is a divider-like block — delete it rather
    // than merging into something that can't hold text.
    editor.commands.block.delete({ blockId: prev });
    return { caret };
  }
  const prevLen = editor.commands.text.length(prev);
  editor.commands.block.merge({ prevId: prev, nextId: caret.blockId });
  return { caret: { blockId: prev, offset: prevLen } };
};

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

/**
 * Find the offset that a word-backwards delete should target — i.e. the start
 * of the run that the caret is currently logically attached to. Walks back from
 * `caret.offset` first over trailing whitespace, then over the contiguous
 * non-whitespace run before that. This matches macOS/Chrome Option+Backspace:
 * `"hello world|"` → delete `"world"`; a second press on `"hello "` deletes
 * `"hello "` (the trailing space is consumed as the leading whitespace skip).
 */
const wordBackwardOffset = (text: string, offset: number): number => {
  let i = Math.min(offset, text.length);
  while (i > 0 && isWhitespace(text[i - 1] ?? "")) i--;
  while (i > 0 && !isWhitespace(text[i - 1] ?? "")) i--;
  return i;
};

export const handleWordBackspace = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  if (caret.offset > 0) {
    const text = editor.commands.text.read(caret.blockId);
    const target = wordBackwardOffset(text, caret.offset);
    if (target < caret.offset) {
      editor.commands.text.delete({
        blockId: caret.blockId,
        offset: target,
        length: caret.offset - target,
      });
      return { caret: { blockId: caret.blockId, offset: target } };
    }
  }
  return handleBackspace(editor, caret);
};

/**
 * Line-backwards delete target — start of the current logical line inside the
 * block. Soft line breaks are represented as inline `\n` in the block's text
 * (see `handleInsertLineBreak`), so "start of line" = position right after
 * the most recent `\n` before the caret, or 0 if there is none.
 */
const lineBackwardOffset = (text: string, offset: number): number => {
  const i = Math.min(offset, text.length);
  const slice = text.slice(0, i);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline < 0 ? 0 : lastNewline + 1;
};

export const handleLineBackspace = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  if (caret.offset > 0) {
    const text = editor.commands.text.read(caret.blockId);
    const target = lineBackwardOffset(text, caret.offset);
    if (target < caret.offset) {
      editor.commands.text.delete({
        blockId: caret.blockId,
        offset: target,
        length: caret.offset - target,
      });
      return { caret: { blockId: caret.blockId, offset: target } };
    }
  }
  // At offset 0 — or right after a `\n` with nothing to delete on the current
  // line — defer to char-backspace so block-merge / heading-demote / soft-break
  // removal still works.
  return handleBackspace(editor, caret);
};

export const handleDeleteForward = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  const block = getBlock(editor, caret.blockId);
  // Caret on a divider-like block: forward-delete removes the block itself.
  if (block && !block.hasInline) {
    const next = docOrderNeighbor(editor, caret.blockId, 1);
    editor.commands.block.delete({ blockId: caret.blockId });
    if (next) return { caret: { blockId: next, offset: 0 } };
    const first = getChildren(editor, rootId(editor))[0];
    return first ? { caret: { blockId: first, offset: 0 } } : null;
  }
  const len = editor.commands.text.length(caret.blockId);
  if (caret.offset < len) {
    editor.commands.text.delete({
      blockId: caret.blockId,
      offset: caret.offset,
      length: 1,
    });
    return { caret };
  }
  const next = docOrderNeighbor(editor, caret.blockId, 1);
  if (!next) return null;
  const nextBlock = getBlock(editor, next);
  if (nextBlock && !nextBlock.hasInline) {
    // Forward-delete into a divider-like block removes it.
    editor.commands.block.delete({ blockId: next });
    return { caret };
  }
  editor.commands.block.merge({ prevId: caret.blockId, nextId: next });
  return { caret };
};

/** Symmetric forward counterpart of `wordBackwardOffset`. */
const wordForwardOffset = (text: string, offset: number): number => {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i < text.length && isWhitespace(text[i] ?? "")) i++;
  while (i < text.length && !isWhitespace(text[i] ?? "")) i++;
  return i;
};

export const handleWordDeleteForward = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  const text = editor.commands.text.read(caret.blockId);
  if (caret.offset < text.length) {
    const target = wordForwardOffset(text, caret.offset);
    if (target > caret.offset) {
      editor.commands.text.delete({
        blockId: caret.blockId,
        offset: caret.offset,
        length: target - caret.offset,
      });
      return { caret };
    }
  }
  return handleDeleteForward(editor, caret);
};

/** Forward counterpart of `lineBackwardOffset`. */
const lineForwardOffset = (text: string, offset: number): number => {
  const start = Math.max(0, Math.min(offset, text.length));
  const idx = text.indexOf("\n", start);
  return idx < 0 ? text.length : idx;
};

export const handleLineDeleteForward = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  const text = editor.commands.text.read(caret.blockId);
  if (caret.offset < text.length) {
    const target = lineForwardOffset(text, caret.offset);
    if (target > caret.offset) {
      editor.commands.text.delete({
        blockId: caret.blockId,
        offset: caret.offset,
        length: target - caret.offset,
      });
      return { caret };
    }
  }
  return handleDeleteForward(editor, caret);
};

interface MarkSegment {
  readonly blockId: BlockId;
  readonly start: number;
  readonly end: number;
}

/**
 * Resolve a (possibly cross-block) DOM range into the per-block character
 * segments a mark should cover. A single-block range keeps the existing
 * collapsed-selection-means-whole-block behaviour.
 */
const computeMarkSegments = (
  editor: Editor,
  range: DomRange,
): MarkSegment[] => {
  if (range.anchor.blockId === range.focus.blockId) {
    const single = computeMarkRangeWithinBlock(editor, range);
    return single ? [single] : [];
  }
  const order = getChildren(editor, rootId(editor));
  const ai = order.indexOf(range.anchor.blockId);
  const fi = order.indexOf(range.focus.blockId);
  if (ai < 0 || fi < 0) return [];
  const [start, end] =
    ai <= fi ? [range.anchor, range.focus] : [range.focus, range.anchor];
  const ids = order.slice(Math.min(ai, fi), Math.max(ai, fi) + 1);
  const segments: MarkSegment[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const segStart = i === 0 ? start.offset : 0;
    const segEnd =
      i === ids.length - 1 ? end.offset : editor.commands.text.length(id);
    if (segEnd > segStart) {
      segments.push({ blockId: id, start: segStart, end: segEnd });
    }
  }
  return segments;
};

/** Whether `mark` already covers every character of `segment`. */
const isSegmentFullyMarked = (
  editor: Editor,
  segment: MarkSegment,
  mark: string,
): boolean => {
  const delta = editor.commands.text.toDelta(segment.blockId) as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>;
  let coverage = 0;
  let cursor = 0;
  for (const part of delta) {
    if (typeof part.insert !== "string") continue;
    const partStart = cursor;
    const partEnd = cursor + part.insert.length;
    const overlapStart = Math.max(partStart, segment.start);
    const overlapEnd = Math.min(partEnd, segment.end);
    if (
      overlapEnd > overlapStart &&
      part.attributes &&
      part.attributes[mark] !== undefined
    ) {
      coverage += overlapEnd - overlapStart;
    }
    cursor = partEnd;
  }
  return segment.end > segment.start && coverage >= segment.end - segment.start;
};

export const handleToggleMark = (
  editor: Editor,
  range: DomRange,
  mark: "bold" | "italic" | "underline" | "strike",
): ApplyResult | null => {
  const segments = computeMarkSegments(editor, range);
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    const r = segments[0]!;
    editor.commands.text.toggleMark({
      blockId: r.blockId,
      range: { start: r.start, end: r.end },
      mark,
    });
    return { caret: range.focus };
  }
  // Cross-block: decide globally, then flip only the segments that need it
  // (`toggleMark` is per-segment, so flipping an already-correct one is wrong).
  const allOn = segments.every((s) => isSegmentFullyMarked(editor, s, mark));
  for (const s of segments) {
    const on = isSegmentFullyMarked(editor, s, mark);
    if (allOn ? on : !on) {
      editor.commands.text.toggleMark({
        blockId: s.blockId,
        range: { start: s.start, end: s.end },
        mark,
      });
    }
  }
  return { caret: range.focus };
};

/** Strip every inline mark from the (possibly cross-block) selection. */
export const handleClearFormatting = (
  editor: Editor,
  range: DomRange,
): ApplyResult | null => {
  const segments = computeMarkSegments(editor, range);
  if (segments.length === 0) return null;
  for (const s of segments) {
    editor.commands.text.clearMarks({
      blockId: s.blockId,
      range: { start: s.start, end: s.end },
    });
  }
  return { caret: range.focus };
};

export const isParagraphLike = (kind: BlockKind): boolean =>
  Match.value(kind).pipe(
    Match.whenOr(
      "paragraph",
      "heading",
      "quote",
      "bullet-list-item",
      "numbered-list-item",
      "to-do",
      () => true,
    ),
    Match.whenOr(
      "code",
      "divider",
      "image",
      "embed",
      "toggle",
      "table",
      "table-row",
      "table-cell",
      () => false,
    ),
    Match.exhaustive,
  );
