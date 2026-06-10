import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "../src/index.js";

/**
 * `comment-anchor` mark — specs/lexical-parity.md §2 ("Custom marks (e.g.
 * comments) | comment-anchor (internal)") mirroring Lexical's `MarkNode`.
 * The mark anchors a comment thread to a text range; the thread payload
 * itself lives in a sibling LoroDoc container (§4 CommentPlugin row — not
 * this surface). The mark VALUE is `{ threadId }`.
 */

const editorWithText = (value: string) => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  editor.commands.text.insert({ blockId: id, offset: 0, value });
  return { editor, id };
};

describe("@weaver/core / comment-anchor mark", () => {
  it("anchors a thread to a range and surfaces it in the delta", () => {
    const { editor, id } = editorWithText("hello world");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { "comment-anchor": { threadId: "t-1" } } },
      { insert: " world" },
    ]);
    editor.dispose();
  });

  it("rejects a value without a non-empty threadId", () => {
    const { editor, id } = editorWithText("hello");
    for (const value of [undefined, {}, { threadId: "" }, { threadId: 7 }]) {
      expect(() =>
        editor.commands.text.toggleMark({
          blockId: id,
          range: { start: 0, end: 5 },
          mark: "comment-anchor",
          value,
        }),
      ).toThrow(/threadId/);
    }
    editor.dispose();
  });

  it("does not extend when typing at the trailing edge (expand: none)", () => {
    const { editor, id } = editorWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    editor.commands.text.insert({ blockId: id, offset: 5, value: "!" });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { "comment-anchor": { threadId: "t-1" } } },
      { insert: "!" },
    ]);
    editor.dispose();
  });

  it("toggling an anchored range off removes the anchor", () => {
    const { editor, id } = editorWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    expect(editor.commands.text.toDelta(id)).toEqual([{ insert: "hello" }]);
    editor.dispose();
  });

  it("clearMarks strips formatting but PRESERVES comment anchors", () => {
    // block-model.md: comment-anchor is "Internal; … not exposed to
    // formatting UI" — a clear-formatting action must not orphan a thread.
    const { editor, id } = editorWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    editor.commands.text.clearMarks({ blockId: id, range: { start: 0, end: 5 } });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { "comment-anchor": { threadId: "t-1" } } },
    ]);
    editor.dispose();
  });

  it("re-anchoring a fully-covered range to a different thread REPLACES the anchor", () => {
    // The toggle-off coverage check must be value-aware: applying t-2 over an
    // existing t-1 anchor replaces the binding instead of silently deleting it.
    const { editor, id } = editorWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-1" },
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "comment-anchor",
      value: { threadId: "t-2" },
    });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { "comment-anchor": { threadId: "t-2" } } },
    ]);
    editor.dispose();
  });

  it("survives a split that bisects the anchored range", () => {
    const { editor, id } = editorWithText("hello world");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 8 },
      mark: "comment-anchor",
      value: { threadId: "t-3" },
    });
    const tailId = editor.commands.block.split({ blockId: id, offset: 6 });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hel" },
      { insert: "lo ", attributes: { "comment-anchor": { threadId: "t-3" } } },
    ]);
    expect(editor.commands.text.toDelta(tailId)).toEqual([
      { insert: "wo", attributes: { "comment-anchor": { threadId: "t-3" } } },
      { insert: "rld" },
    ]);
    editor.dispose();
  });

  it("survives a block split with the range intact", () => {
    const { editor, id } = editorWithText("hello world");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 6, end: 11 },
      mark: "comment-anchor",
      value: { threadId: "t-2" },
    });
    const tailId = editor.commands.block.split({ blockId: id, offset: 6 });
    expect(editor.commands.text.toDelta(tailId)).toEqual([
      { insert: "world", attributes: { "comment-anchor": { threadId: "t-2" } } },
    ]);
    editor.dispose();
  });
});
