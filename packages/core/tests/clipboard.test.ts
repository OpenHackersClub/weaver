import { describe, expect, it } from "vitest";
import { createEditor, getBlock, getChildren, rootId } from "../src/index.js";
import { future, setMark, type FutureEditor } from "./_test-helpers.js";

/**
 * Clipboard command surface — specs/lexical-parity.md §3:
 * "Clipboard (COPY_COMMAND / CUT_COMMAND / PASTE_COMMAND) → `clipboard.*`
 * surface with HTML / Markdown / weaver+loro serialization".
 *
 * This suite covers the core (DOM-free) half of that row: a structured
 * `ClipboardPayload` { text, blocks } that the @weaver/dom bridge serializes
 * onto the system clipboard. HTML / Markdown codecs are the
 * @weaver/plugins-html / @weaver/plugins-markdown follow-up (🔁 rows).
 */

/** Fresh editor whose first (seeded) paragraph holds `value`. */
const editorWithParagraph = (value: string) => {
  const editor = future(createEditor());
  const root = rootId(editor);
  const id = getChildren(editor, root)[0]!;
  if (value) editor.commands.text.insert({ blockId: id, offset: 0, value });
  return { editor, root, id };
};

const addBlock = (
  editor: FutureEditor,
  kind: Parameters<FutureEditor["commands"]["block"]["insert"]>[0]["kind"],
  text: string,
  attrs?: Record<string, unknown>,
) => {
  const root = rootId(editor);
  const index = getChildren(editor, root).length;
  const id = editor.commands.block.insert({ parentId: root, index, kind, attrs });
  if (text) editor.commands.text.insert({ blockId: id, offset: 0, value: text });
  return id;
};

describe("@weaver/core / clipboard.copy", () => {
  it("returns null when there is no selection", () => {
    const { editor } = editorWithParagraph("hello");
    expect(editor.commands.clipboard.copy()).toBeNull();
    editor.dispose();
  });

  it("returns null for a collapsed selection", () => {
    const { editor, id } = editorWithParagraph("hello");
    editor.commands.selection.collapse(id, 2);
    expect(editor.commands.clipboard.copy()).toBeNull();
    editor.dispose();
  });

  it("serializes a within-block range as one fragment with sliced text", () => {
    const { editor, id } = editorWithParagraph("hello");
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 1 },
      focus: { blockId: id, offset: 4 },
    });
    const payload = editor.commands.clipboard.copy();
    expect(payload).not.toBeNull();
    expect(payload!.text).toBe("ell");
    expect(payload!.blocks).toHaveLength(1);
    expect(payload!.blocks[0]!.kind).toBe("paragraph");
    expect(payload!.blocks[0]!.delta).toEqual([{ insert: "ell" }]);
    expect(payload!.blocks[0]!.children).toEqual([]);
    editor.dispose();
  });

  it("preserves marks in the copied delta", () => {
    const { editor, id } = editorWithParagraph("hello world");
    setMark(editor, { blockId: id, range: { start: 0, end: 5 }, mark: "bold" });
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 3 },
      focus: { blockId: id, offset: 8 },
    });
    const payload = editor.commands.clipboard.copy()!;
    expect(payload.text).toBe("lo wo");
    expect(payload.blocks[0]!.delta).toEqual([
      { insert: "lo", attributes: { bold: true } },
      { insert: " wo" },
    ]);
    editor.dispose();
  });

  it("does not mutate the document", () => {
    const { editor, id } = editorWithParagraph("hello");
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 0 },
      focus: { blockId: id, offset: 5 },
    });
    editor.commands.clipboard.copy();
    expect(editor.commands.text.read(id)).toBe("hello");
    editor.dispose();
  });

  it("serializes a multi-block range with partial start/end slices and kinds", () => {
    const { editor, id: p } = editorWithParagraph("hello");
    const h = addBlock(editor, "heading", "world", { level: 1 });
    editor.commands.selection.set({
      anchor: { blockId: p, offset: 2 },
      focus: { blockId: h, offset: 3 },
    });
    const payload = editor.commands.clipboard.copy()!;
    expect(payload.text).toBe("llo\nwor");
    expect(payload.blocks.map((b) => b.kind)).toEqual(["paragraph", "heading"]);
    expect(payload.blocks[0]!.delta).toEqual([{ insert: "llo" }]);
    expect(payload.blocks[1]!.delta).toEqual([{ insert: "wor" }]);
    expect(payload.blocks[1]!.attrs).toMatchObject({ level: 1 });
    editor.dispose();
  });

  it("includes non-inline blocks (divider) without a delta", () => {
    const { editor, id: p } = editorWithParagraph("above");
    addBlock(editor, "divider", "");
    const below = addBlock(editor, "paragraph", "below");
    editor.commands.selection.set({
      anchor: { blockId: p, offset: 0 },
      focus: { blockId: below, offset: 5 },
    });
    const payload = editor.commands.clipboard.copy()!;
    expect(payload.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "divider",
      "paragraph",
    ]);
    expect(payload.blocks[1]!.delta).toBeUndefined();
    editor.dispose();
  });

  it("preserves nesting: a selected child appears under its selected parent", () => {
    const { editor, id: p } = editorWithParagraph("intro");
    const item = addBlock(editor, "bullet-list-item", "parent item");
    const childId = editor.commands.block.insert({
      parentId: item,
      index: 0,
      kind: "bullet-list-item",
    });
    editor.commands.text.insert({ blockId: childId, offset: 0, value: "nested" });
    editor.commands.selection.selectAll();
    const payload = editor.commands.clipboard.copy()!;
    expect(payload.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "bullet-list-item",
    ]);
    const parentFrag = payload.blocks[1]!;
    expect(parentFrag.children).toHaveLength(1);
    expect(parentFrag.children[0]!.kind).toBe("bullet-list-item");
    expect(parentFrag.children[0]!.delta).toEqual([{ insert: "nested" }]);
    expect(payload.text).toBe("intro\nparent item\nnested");
    expect(p).toBeDefined();
    editor.dispose();
  });
});

describe("@weaver/core / clipboard.cut", () => {
  it("returns the payload and removes a within-block range", () => {
    const { editor, id } = editorWithParagraph("hello");
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 1 },
      focus: { blockId: id, offset: 4 },
    });
    const payload = editor.commands.clipboard.cut();
    expect(payload!.text).toBe("ell");
    expect(editor.commands.text.read(id)).toBe("ho");
    const sel = editor.commands.selection.get();
    expect(sel).toEqual({
      anchor: { blockId: id, offset: 1 },
      focus: { blockId: id, offset: 1 },
    });
    editor.dispose();
  });

  it("returns null and leaves the doc untouched for a collapsed selection", () => {
    const { editor, id } = editorWithParagraph("hello");
    editor.commands.selection.collapse(id, 2);
    expect(editor.commands.clipboard.cut()).toBeNull();
    expect(editor.commands.text.read(id)).toBe("hello");
    editor.dispose();
  });

  it("removes a multi-block range, merging the endpoints", () => {
    const { editor, root, id: p } = editorWithParagraph("hello");
    const h = addBlock(editor, "heading", "world", { level: 2 });
    editor.commands.selection.set({
      anchor: { blockId: p, offset: 2 },
      focus: { blockId: h, offset: 3 },
    });
    const payload = editor.commands.clipboard.cut();
    expect(payload!.text).toBe("llo\nwor");
    expect(getChildren(editor, root)).toHaveLength(1);
    expect(editor.commands.text.read(p)).toBe("held");
    editor.dispose();
  });
});

describe("@weaver/core / clipboard.paste — structured payloads", () => {
  it("pastes a single inline fragment at the caret, preserving marks", () => {
    const { editor, id } = editorWithParagraph("AD");
    editor.commands.selection.collapse(id, 1);
    editor.commands.clipboard.paste({
      text: "bc",
      blocks: [
        {
          kind: "paragraph",
          attrs: {},
          delta: [{ insert: "bc", attributes: { bold: true } }],
          children: [],
        },
      ],
    });
    expect(editor.commands.text.read(id)).toBe("AbcD");
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "A" },
      { insert: "bc", attributes: { bold: true } },
      { insert: "D" },
    ]);
    // Caret lands after the pasted run.
    expect(editor.commands.selection.get()).toEqual({
      anchor: { blockId: id, offset: 3 },
      focus: { blockId: id, offset: 3 },
    });
    editor.dispose();
  });

  it("pastes multiple blocks mid-block: first merges into the anchor, last absorbs the tail", () => {
    const { editor, root, id } = editorWithParagraph("ABCD");
    editor.commands.selection.collapse(id, 2);
    editor.commands.clipboard.paste({
      text: "xx\nyy",
      blocks: [
        { kind: "paragraph", attrs: {}, delta: [{ insert: "xx" }], children: [] },
        {
          kind: "heading",
          attrs: { level: 1 },
          delta: [{ insert: "yy" }],
          children: [],
        },
      ],
    });
    const children = getChildren(editor, root);
    expect(children).toHaveLength(2);
    expect(editor.commands.text.read(children[0]!)).toBe("ABxx");
    expect(getBlock(editor, children[1]!)!.kind).toBe("heading");
    expect(editor.commands.text.read(children[1]!)).toBe("yyCD");
    // Caret sits at the end of the pasted content, before the absorbed tail.
    expect(editor.commands.selection.get()).toEqual({
      anchor: { blockId: children[1]!, offset: 2 },
      focus: { blockId: children[1]!, offset: 2 },
    });
    editor.dispose();
  });

  it("replaces a non-collapsed selection before inserting", () => {
    const { editor, id } = editorWithParagraph("hello world");
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 6 },
      focus: { blockId: id, offset: 11 },
    });
    editor.commands.clipboard.paste({
      text: "weaver",
      blocks: [
        { kind: "paragraph", attrs: {}, delta: [{ insert: "weaver" }], children: [] },
      ],
    });
    expect(editor.commands.text.read(id)).toBe("hello weaver");
    editor.dispose();
  });

  it("pastes a non-inline block (divider) by splitting around it", () => {
    const { editor, root, id } = editorWithParagraph("ABCD");
    editor.commands.selection.collapse(id, 2);
    editor.commands.clipboard.paste({
      text: "",
      blocks: [{ kind: "divider", attrs: {}, children: [] }],
    });
    const children = getChildren(editor, root);
    expect(children).toHaveLength(3);
    expect(editor.commands.text.read(children[0]!)).toBe("AB");
    expect(getBlock(editor, children[1]!)!.kind).toBe("divider");
    expect(editor.commands.text.read(children[2]!)).toBe("CD");
    editor.dispose();
  });

  it("pastes nested fragments preserving the child tree", () => {
    const { editor, root, id } = editorWithParagraph("");
    editor.commands.selection.collapse(id, 0);
    editor.commands.clipboard.paste({
      text: "parent\nnested",
      blocks: [
        { kind: "paragraph", attrs: {}, delta: [{ insert: "lead" }], children: [] },
        {
          kind: "bullet-list-item",
          attrs: {},
          delta: [{ insert: "parent" }],
          children: [
            {
              kind: "bullet-list-item",
              attrs: {},
              delta: [{ insert: "nested" }],
              children: [],
            },
          ],
        },
      ],
    });
    const children = getChildren(editor, root);
    expect(children).toHaveLength(2);
    expect(editor.commands.text.read(children[0]!)).toBe("lead");
    const item = getBlock(editor, children[1]!)!;
    expect(item.kind).toBe("bullet-list-item");
    expect(editor.commands.text.read(children[1]!)).toBe("parent");
    expect(item.childIds).toHaveLength(1);
    expect(editor.commands.text.read(item.childIds[0]!)).toBe("nested");
    editor.dispose();
  });

  it("round-trips: copy from one editor, paste into another", () => {
    const { editor: a, id: ap } = editorWithParagraph("hello");
    const ah = addBlock(a, "heading", "world", { level: 2 });
    setMark(a, { blockId: ap, range: { start: 0, end: 5 }, mark: "italic" });
    a.commands.selection.set({
      anchor: { blockId: ap, offset: 0 },
      focus: { blockId: ah, offset: 5 },
    });
    const payload = a.commands.clipboard.copy()!;

    const { editor: b, root: bRoot, id: bp } = editorWithParagraph("");
    b.commands.selection.collapse(bp, 0);
    b.commands.clipboard.paste(payload);
    const children = getChildren(b, bRoot);
    expect(children).toHaveLength(2);
    expect(b.commands.text.read(children[0]!)).toBe("hello");
    expect(b.commands.text.toDelta(children[0]!)).toEqual([
      { insert: "hello", attributes: { italic: true } },
    ]);
    const head = getBlock(b, children[1]!)!;
    expect(head.kind).toBe("heading");
    expect(head.attrs).toMatchObject({ level: 2 });
    expect(b.commands.text.read(children[1]!)).toBe("world");
    a.dispose();
    b.dispose();
  });

  it("is a no-op without a selection", () => {
    const { editor, root } = editorWithParagraph("hello");
    editor.commands.clipboard.paste({
      text: "x",
      blocks: [
        { kind: "paragraph", attrs: {}, delta: [{ insert: "x" }], children: [] },
      ],
    });
    const children = getChildren(editor, root);
    expect(children).toHaveLength(1);
    expect(editor.commands.text.read(children[0]!)).toBe("hello");
    editor.dispose();
  });
});

describe("@weaver/core / clipboard.pasteText — plain text", () => {
  it("inserts a single line at the caret", () => {
    const { editor, id } = editorWithParagraph("AD");
    editor.commands.selection.collapse(id, 1);
    editor.commands.clipboard.pasteText("bc");
    expect(editor.commands.text.read(id)).toBe("AbcD");
    editor.dispose();
  });

  it("splits multi-line text into blocks, inheriting the anchor kind", () => {
    const { editor, root } = editorWithParagraph("");
    const h = addBlock(editor, "heading", "AB", { level: 3 });
    editor.commands.selection.collapse(h, 1);
    editor.commands.clipboard.pasteText("one\ntwo\nthree");
    const children = getChildren(editor, root);
    // seeded paragraph + heading split into 3
    expect(children).toHaveLength(4);
    expect(editor.commands.text.read(children[1]!)).toBe("Aone");
    expect(editor.commands.text.read(children[2]!)).toBe("two");
    expect(editor.commands.text.read(children[3]!)).toBe("threeB");
    expect(getBlock(editor, children[2]!)!.kind).toBe("heading");
    expect(getBlock(editor, children[3]!)!.kind).toBe("heading");
    // Caret after "three" in the last block.
    expect(editor.commands.selection.get()).toEqual({
      anchor: { blockId: children[3]!, offset: 5 },
      focus: { blockId: children[3]!, offset: 5 },
    });
    editor.dispose();
  });

  it("replaces a non-collapsed selection", () => {
    const { editor, id } = editorWithParagraph("hello world");
    editor.commands.selection.set({
      anchor: { blockId: id, offset: 0 },
      focus: { blockId: id, offset: 5 },
    });
    editor.commands.clipboard.pasteText("bye");
    expect(editor.commands.text.read(id)).toBe("bye world");
    editor.dispose();
  });

  it("normalizes CRLF line endings", () => {
    const { editor, root, id } = editorWithParagraph("");
    editor.commands.selection.collapse(id, 0);
    editor.commands.clipboard.pasteText("a\r\nb");
    const children = getChildren(editor, root);
    expect(children).toHaveLength(2);
    expect(editor.commands.text.read(children[0]!)).toBe("a");
    expect(editor.commands.text.read(children[1]!)).toBe("b");
    editor.dispose();
  });

  it("paste() with a text-only payload falls back to pasteText", () => {
    const { editor, id } = editorWithParagraph("AD");
    editor.commands.selection.collapse(id, 1);
    editor.commands.clipboard.paste({ text: "bc" });
    expect(editor.commands.text.read(id)).toBe("AbcD");
    editor.dispose();
  });

  it("is a no-op for empty text", () => {
    const { editor, id } = editorWithParagraph("AB");
    editor.commands.selection.collapse(id, 1);
    editor.commands.clipboard.pasteText("");
    expect(editor.commands.text.read(id)).toBe("AB");
    editor.dispose();
  });
});
