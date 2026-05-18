import type { BlockId, BlockKind, Editor } from "@weaver/core";
import { getBlock, getChildren, rootId } from "@weaver/core";
import {
  type DomCaret,
  type DomRange,
  computeMarkRangeWithinBlock,
} from "./selection-mapper.js";

export type IntendedCaret = DomCaret;

export interface ApplyResult {
  readonly caret: IntendedCaret;
}

const previousSibling = (editor: Editor, id: BlockId): BlockId | null => {
  const kids = getChildren(editor, rootId(editor));
  const i = kids.indexOf(id);
  if (i <= 0) return null;
  return kids[i - 1] ?? null;
};

const nextSibling = (editor: Editor, id: BlockId): BlockId | null => {
  const kids = getChildren(editor, rootId(editor));
  const i = kids.indexOf(id);
  if (i < 0 || i + 1 >= kids.length) return null;
  return kids[i + 1] ?? null;
};

export const handleInsertText = (
  editor: Editor,
  caret: DomCaret,
  value: string,
): ApplyResult => {
  editor.commands.text.insert({
    blockId: caret.blockId,
    offset: caret.offset,
    value,
  });
  const newCaret: DomCaret = { blockId: caret.blockId, offset: caret.offset + value.length };
  maybeApplyMarkdownShortcut(editor, newCaret);
  return { caret: latestCaret(editor, caret, newCaret) };
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

const maybeApplyMarkdownShortcut = (editor: Editor, caret: DomCaret): void => {
  const block = getBlock(editor, caret.blockId);
  if (!block) return;
  if (block.kind !== "paragraph") return;
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
    return;
  }

  // Divider — check before bullet (`*** ` must not be read as `* `).
  if (text === "--- " || text === "*** ") {
    transformBlock(4, "divider");
    return;
  }

  // Code fence — 3 backticks + space.
  if (text === "``` ") {
    transformBlock(4, "code");
    return;
  }

  // Quote.
  if (text === "> ") {
    transformBlock(2, "quote");
    return;
  }

  // Bullet list — `- ` or `* `.
  if (text === "- " || text === "* ") {
    transformBlock(2, "bullet-list-item");
    return;
  }

  // Numbered list — `\d+. `.
  if (MARKDOWN_NUMBERED.test(text)) {
    transformBlock(text.length, "numbered-list-item");
    return;
  }

  // To-do — `[ ] ` / `[x] ` / `[X] `.
  if (text === "[ ] ") {
    transformBlock(4, "to-do", { checked: false });
    return;
  }
  if (text === "[x] " || text === "[X] ") {
    transformBlock(4, "to-do", { checked: true });
    return;
  }

  // No block-level transform fired — try inline delimiter shortcuts.
  applyInlineShortcut(editor, caret);
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
  const newId = editor.commands.block.split({
    blockId: caret.blockId,
    offset: caret.offset,
  });
  return { caret: { blockId: newId, offset: 0 } };
};

export const handleBackspace = (editor: Editor, caret: DomCaret): ApplyResult | null => {
  if (caret.offset > 0) {
    editor.commands.text.delete({
      blockId: caret.blockId,
      offset: caret.offset - 1,
      length: 1,
    });
    return { caret: { blockId: caret.blockId, offset: caret.offset - 1 } };
  }
  // offset === 0
  const prev = previousSibling(editor, caret.blockId);
  if (!prev) {
    // first block, offset 0 — if heading, demote to paragraph
    const b = getBlock(editor, caret.blockId);
    if (b && b.kind !== "paragraph") {
      editor.commands.block.transform({
        blockId: caret.blockId,
        newKind: "paragraph",
        attrs: {},
      });
      return { caret };
    }
    return null;
  }
  const prevLen = editor.commands.text.length(prev);
  editor.commands.block.merge({ prevId: prev, nextId: caret.blockId });
  return { caret: { blockId: prev, offset: prevLen } };
};

export const handleDeleteForward = (
  editor: Editor,
  caret: DomCaret,
): ApplyResult | null => {
  const len = editor.commands.text.length(caret.blockId);
  if (caret.offset < len) {
    editor.commands.text.delete({
      blockId: caret.blockId,
      offset: caret.offset,
      length: 1,
    });
    return { caret };
  }
  const next = nextSibling(editor, caret.blockId);
  if (!next) return null;
  editor.commands.block.merge({ prevId: caret.blockId, nextId: next });
  return { caret };
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
  kind === "paragraph" ||
  kind === "heading" ||
  kind === "quote" ||
  kind === "bullet-list-item" ||
  kind === "numbered-list-item" ||
  kind === "to-do";
