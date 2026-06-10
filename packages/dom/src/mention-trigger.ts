import type { BlockId, Editor } from "@weaver/core";
import type { DomCaret } from "./selection-mapper.js";

/**
 * An active @-mention trigger — the Notion-style typeahead state. Produced by
 * scanning the text behind a collapsed caret: `"say hi to @ad|"` yields
 * `{ start: 10, end: 13, query: "ad" }` (start points at the `@`).
 *
 * This is ephemeral UI state — it never touches LoroDoc. The UI layer owns
 * where it lives (an Effect `SubscriptionRef` per ADR 0006); this module only
 * computes it.
 */
export interface MentionTrigger {
  readonly blockId: BlockId;
  /** Offset of the `@` character in the block's text. */
  readonly start: number;
  /** Caret offset — exclusive end of the query text. */
  readonly end: number;
  /** Text between the `@` and the caret (may be empty right after typing @). */
  readonly query: string;
  /**
   * Viewport rectangle of the trigger's `@` anchor, for positioning a picker.
   * `null` when the DOM rect cannot be resolved (e.g. headless tests).
   */
  readonly rect: { left: number; top: number; bottom: number } | null;
}

/** Longest query we will treat as a live trigger before giving up. */
const MAX_QUERY_LENGTH = 40;

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

/**
 * Detect an active mention trigger behind `caret`, or `null`.
 *
 * Rules (matching Notion / Lexical typeahead behaviour):
 * - the `@` must start the block or follow whitespace — `a@b` (an email,
 *   a handle mid-word) is not a trigger;
 * - the query between `@` and caret contains no whitespace and no second `@`;
 * - the query is at most {@link MAX_QUERY_LENGTH} chars.
 */
export const detectMentionTrigger = (
  editor: Editor,
  caret: DomCaret,
): Omit<MentionTrigger, "rect"> | null => {
  const text = editor.commands.text.read(caret.blockId);
  const offset = Math.max(0, Math.min(caret.offset, text.length));
  const windowStart = Math.max(0, offset - MAX_QUERY_LENGTH - 1);
  let at = -1;
  for (let i = offset - 1; i >= windowStart; i--) {
    const ch = text[i] ?? "";
    if (ch === "@") {
      at = i;
      break;
    }
    if (isWhitespace(ch)) return null;
  }
  if (at < 0) return null;
  const before = at === 0 ? "" : (text[at - 1] ?? "");
  if (before !== "" && !isWhitespace(before)) return null;
  const query = text.slice(at + 1, offset);
  if (query.length > MAX_QUERY_LENGTH) return null;
  return { blockId: caret.blockId, start: at, end: offset, query };
};

const rectsEqual = (
  a: MentionTrigger["rect"],
  b: MentionTrigger["rect"],
): boolean => {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.bottom === b.bottom;
};

export const mentionTriggersEqual = (
  a: MentionTrigger | null,
  b: MentionTrigger | null,
): boolean => {
  if (a === null || b === null) return a === b;
  return (
    a.blockId === b.blockId &&
    a.start === b.start &&
    a.end === b.end &&
    a.query === b.query &&
    // The rect participates in equality so scroll / layout reflow (which
    // changes only the anchor position) still reaches the picker.
    rectsEqual(a.rect, b.rect)
  );
};
