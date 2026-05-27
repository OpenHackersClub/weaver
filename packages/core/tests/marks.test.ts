import { describe, expect, it } from "vitest";
import {
  createEditor,
  getChildren,
  rootId,
  type MarkKind,
} from "../src/index.js";
import { future } from "./_test-helpers.js";

interface DeltaItem {
  readonly insert?: string;
  readonly attributes?: Record<string, unknown>;
}

const seedBlockWithText = (text: string) => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  if (text.length > 0) {
    editor.commands.text.insert({ blockId: id, offset: 0, value: text });
  }
  return { editor, id };
};

const readDelta = (editor: ReturnType<typeof createEditor>, blockId: string) =>
  editor.commands.text.toDelta(blockId) as ReadonlyArray<DeltaItem>;

const markedAttr = (delta: ReadonlyArray<DeltaItem>, mark: string): unknown[] =>
  delta
    .filter((d) => typeof d.insert === "string" && d.attributes !== undefined)
    .map((d) => d.attributes?.[mark])
    .filter((v) => v !== undefined);

describe("@weaver/core / marks — applied via toggleMark on a range", () => {
  const allMarks: MarkKind[] = [
    "bold",
    "italic",
    "underline",
    "strike",
    "code",
    "highlight",
  ];
  for (const mark of allMarks) {
    it(`applies '${mark}' over the selected range`, () => {
      const { editor, id } = seedBlockWithText("hello");
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 0, end: 5 },
        mark,
      });
      const delta = readDelta(editor, id);
      expect(delta).toHaveLength(1);
      expect(delta[0]).toMatchObject({
        insert: "hello",
        attributes: { [mark]: expect.anything() },
      });
      editor.dispose();
    });

    it(`toggles '${mark}' off when the full range already has it`, () => {
      const { editor, id } = seedBlockWithText("hello");
      const range = { start: 0, end: 5 };
      editor.commands.text.toggleMark({ blockId: id, range, mark });
      editor.commands.text.toggleMark({ blockId: id, range, mark });
      expect(readDelta(editor, id)).toEqual([{ insert: "hello" }]);
      editor.dispose();
    });
  }

  it("applies bold over a sub-range only", () => {
    const { editor, id } = seedBlockWithText("abcdef");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 2, end: 4 },
      mark: "bold",
    });
    expect(readDelta(editor, id)).toEqual([
      { insert: "ab" },
      { insert: "cd", attributes: { bold: true } },
      { insert: "ef" },
    ]);
    editor.dispose();
  });

  it("partial-range toggle expands the mark to cover the union (Lexical & Notion semantics)", () => {
    // Initial: bold on [0,3] of "0123456" — only the first three chars are bold.
    // Toggling bold on [2,5] (which is partially covered by the existing mark)
    // should *extend* bold to cover [0,5], not strip it from [0,2].
    // This matches Lexical's bitmask-on-touched-runs semantics and Notion's
    // toolbar UX: clicking bold over a partial-bold selection makes it all bold.
    const { editor, id } = seedBlockWithText("0123456");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 3 },
      mark: "bold",
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 2, end: 5 },
      mark: "bold",
    });
    const delta = readDelta(editor, id);
    const allBold = delta.every(
      (d) => d.insert === undefined || !!d.attributes?.["bold"] || d.insert!.length === 0,
    );
    // Either rendered as one run [0,5]+[5,7], or multiple runs whose union
    // covers [0,5] with bold.
    const coveredBold = delta
      .filter((d) => typeof d.insert === "string" && !!d.attributes?.["bold"])
      .reduce((acc, d) => acc + (d.insert?.length ?? 0), 0);
    expect(coveredBold).toBe(5);
    expect(allBold).toBe(false); // tail "56" should NOT be bold
    editor.dispose();
  });

  it("strips a mark when the full toggled range was already marked", () => {
    const { editor, id } = seedBlockWithText("0123456");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 7 },
      mark: "bold",
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 2, end: 5 },
      mark: "bold",
    });
    const delta = readDelta(editor, id);
    expect(delta).toEqual([
      { insert: "01", attributes: { bold: true } },
      { insert: "234" },
      { insert: "56", attributes: { bold: true } },
    ]);
    editor.dispose();
  });

  it("supports multiple overlapping marks on the same range", () => {
    const { editor, id } = seedBlockWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "italic",
    });
    expect(readDelta(editor, id)).toEqual([
      { insert: "hello", attributes: { bold: true, italic: true } },
    ]);
    editor.dispose();
  });

  it("a zero-length range is a silent no-op and does not throw", () => {
    // TDD red: core `toggleMark` forwards a zero-length range straight to
    // Loro's `text.mark`, which rejects `start === end` ("Start must be less
    // than end"). The contract should be a silent no-op — implementer must
    // guard `rangeLen === 0` in `editor.ts`. This fails today on that throw.
    const { editor, id } = seedBlockWithText("abc");
    expect(() =>
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 2, end: 2 },
        mark: "bold",
      }),
    ).not.toThrow();
    expect(readDelta(editor, id).map((d) => d.insert).join("")).toBe("abc");
    editor.dispose();
  });
});

describe("@weaver/core / marks — typed payloads (link href, highlight color)", () => {
  it("applies a link mark with an `href` payload", () => {
    const { editor, id } = seedBlockWithText("click me");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 8 },
      mark: "link",
      value: { href: "https://example.com" },
    });
    const delta = readDelta(editor, id);
    expect(delta).toEqual([
      {
        insert: "click me",
        attributes: {
          link: { href: "https://example.com" },
        },
      },
    ]);
    editor.dispose();
  });

  it("a link mark with an empty href is rejected (validation gate)", () => {
    const { editor, id } = seedBlockWithText("click");
    // TDD red: validation should refuse an empty href — current impl accepts
    // any value. The thrown error must name `href` so this can't pass on an
    // unrelated throw.
    expect(() =>
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 0, end: 5 },
        mark: "link",
        value: { href: "" },
      }),
    ).toThrow(/href/i);
    editor.dispose();
  });

  it("applies a highlight mark with a `color` payload", () => {
    const { editor, id } = seedBlockWithText("warn");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "highlight",
      value: { color: "yellow" },
    });
    const delta = readDelta(editor, id);
    const colors = markedAttr(delta, "highlight");
    expect(colors).toEqual([{ color: "yellow" }]);
    editor.dispose();
  });

  it("updates a link's href in place via mark.update without re-toggling", () => {
    const { editor, id } = seedBlockWithText("docs");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "link",
      value: { href: "https://old.example.com" },
    });
    // TDD red: `text.mark.update` is not yet on the surface.
    future(editor).commands.text.mark.update({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "link",
      value: { href: "https://new.example.com" },
    });
    const delta = readDelta(editor, id);
    expect(delta[0]?.attributes?.["link"]).toEqual({
      href: "https://new.example.com",
    });
    editor.dispose();
  });
});

describe("@weaver/core / marks — overlap & expand semantics", () => {
  it("inline `code` and `link` are mutually exclusive over the same span", () => {
    // Per specs/lexical-parity.md §2: "code (inline; cannot overlap link)".
    const { editor, id } = seedBlockWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "link",
      value: { href: "https://example.com" },
    });
    // Applying code over the same span should either throw or strip the link.
    // TDD red: current impl applies both, which the parity spec forbids.
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "code",
    });
    const attrs = readDelta(editor, id)[0]?.attributes ?? {};
    const hasLink = attrs["link"] !== undefined;
    const hasCode = attrs["code"] !== undefined;
    expect([hasLink, hasCode].filter(Boolean)).toHaveLength(1);
    editor.dispose();
  });

  it("an `expand: 'after'` mark grows to include text appended at the run's end", () => {
    const { editor, id } = seedBlockWithText("bold");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "bold",
    });
    editor.commands.text.insert({ blockId: id, offset: 4, value: "er" });
    const delta = readDelta(editor, id);
    const boldLen = delta
      .filter((d) => !!d.attributes?.["bold"])
      .reduce((acc, d) => acc + (d.insert?.length ?? 0), 0);
    expect(boldLen).toBe(6);
    editor.dispose();
  });

  it("an `expand: 'none'` (inline `code`) mark does NOT grow on adjacent insertion", () => {
    const { editor, id } = seedBlockWithText("code");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "code",
    });
    editor.commands.text.insert({ blockId: id, offset: 4, value: "X" });
    const delta = readDelta(editor, id);
    const codeLen = delta
      .filter((d) => !!d.attributes?.["code"])
      .reduce((acc, d) => acc + (d.insert?.length ?? 0), 0);
    expect(codeLen).toBe(4);
    editor.dispose();
  });

  it("`link` mark (expand: 'none') does not bleed past its end", () => {
    const { editor, id } = seedBlockWithText("docs");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "link",
      value: { href: "https://example.com" },
    });
    editor.commands.text.insert({ blockId: id, offset: 4, value: "!" });
    const delta = readDelta(editor, id);
    const linkLen = delta
      .filter((d) => !!d.attributes?.["link"])
      .reduce((acc, d) => acc + (d.insert?.length ?? 0), 0);
    expect(linkLen).toBe(4);
    editor.dispose();
  });
});

describe("@weaver/core / marks — preservation across structural ops", () => {
  it("block.split preserves marks on both halves of the text", () => {
    // Currently the split impl reads `text.toString()` and re-inserts the tail
    // as a plain string — marks on the tail are dropped. TDD red.
    const { editor, id } = seedBlockWithText("hello");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    editor.commands.block.split({ blockId: id, offset: 3 });
    const kids = getChildren(editor, rootId(editor));
    expect(kids).toHaveLength(2);
    const left = readDelta(editor, kids[0]!);
    const right = readDelta(editor, kids[1]!);
    expect(left).toEqual([{ insert: "hel", attributes: { bold: true } }]);
    expect(right).toEqual([{ insert: "lo", attributes: { bold: true } }]);
    editor.dispose();
  });

  it("block.merge keeps each half's mark coverage on its original characters", () => {
    // TDD red: merging currently appends `next.toString()` as plain text, so
    // marks on the next block are lost.
    const { editor, id: firstId } = seedBlockWithText("hel");
    editor.commands.text.toggleMark({
      blockId: firstId,
      range: { start: 0, end: 3 },
      mark: "bold",
    });
    const secondId = editor.commands.block.insert({
      parentId: rootId(editor),
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: "lo" });
    editor.commands.text.toggleMark({
      blockId: secondId,
      range: { start: 0, end: 2 },
      mark: "italic",
    });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    const delta = readDelta(editor, firstId);
    expect(delta).toEqual([
      { insert: "hel", attributes: { bold: true } },
      { insert: "lo", attributes: { italic: true } },
    ]);
    editor.dispose();
  });

  it("block.transform preserves marks on inline text", () => {
    const { editor, id } = seedBlockWithText("Title");
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    expect(readDelta(editor, id)).toEqual([
      { insert: "Title", attributes: { bold: true } },
    ]);
    editor.dispose();
  });

  it("block.merge only prevents expand:after marks from bleeding — expand:none marks are untouched", () => {
    // Regression for B4: bleedKeys filter must only strip expand:after marks
    // (bold, italic, etc.) from the merge region. expand:none marks (code,
    // link, mention) must NOT be unmarked — they can't bleed on insert.
    const { editor, id: firstId } = seedBlockWithText("bold");
    // First char: bold (expand:after). Last char: code (expand:none).
    editor.commands.text.toggleMark({
      blockId: firstId,
      range: { start: 0, end: 2 },
      mark: "bold",
    });
    editor.commands.text.toggleMark({
      blockId: firstId,
      range: { start: 2, end: 4 },
      mark: "code",
    });
    const secondId = editor.commands.block.insert({
      parentId: rootId(editor),
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: " XY" });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    const delta = readDelta(editor, firstId);
    // "bo" bold | "ld" code | " XY" plain
    // Bold must NOT bleed into "ld" or " XY" (unmarked from merge region).
    // Code must still cover "ld" (must NOT be unmarked — it's expand:none).
    expect(delta).toEqual([
      { insert: "bo", attributes: { bold: true } },
      { insert: "ld", attributes: { code: true } },
      { insert: " XY" },
    ]);
    editor.dispose();
  });
});
