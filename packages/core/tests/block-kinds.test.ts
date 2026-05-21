/**
 * Coverage for the v1 Lexical-parity block kinds beyond the seven baseline
 * text kinds: `divider`, `image`, `embed`, `toggle`, and the `table` family.
 * See `specs/lexical-parity.md` §1.
 */
import { describe, expect, it } from "vitest";
import {
  blockKindHasInline,
  createEditor,
  defaultAttrsFor,
  getBlock,
  getChildren,
  rootId,
  type BlockKind,
} from "../src/index.js";

const setup = () => {
  const editor = createEditor();
  return { editor, root: rootId(editor) };
};

describe("@weaver/core / blockKindHasInline coverage", () => {
  const cases: ReadonlyArray<[BlockKind, boolean]> = [
    ["paragraph", true],
    ["heading", true],
    ["quote", true],
    ["bullet-list-item", true],
    ["numbered-list-item", true],
    ["to-do", true],
    ["code", true],
    ["divider", false],
    ["image", false],
    ["embed", false],
    ["toggle", true],
    ["table", false],
    ["table-row", false],
    ["table-cell", true],
  ];
  for (const [kind, expected] of cases) {
    it(`hasInline(${kind}) === ${expected}`, () => {
      expect(blockKindHasInline(kind)).toBe(expected);
    });
  }
});

describe("@weaver/core / defaultAttrsFor", () => {
  it("paragraph default attrs are empty", () => {
    expect(defaultAttrsFor("paragraph")).toEqual({});
  });
  it("heading default level is 1", () => {
    expect(defaultAttrsFor("heading")).toEqual({ level: 1 });
  });
  it("to-do default checked is false", () => {
    expect(defaultAttrsFor("to-do")).toEqual({ checked: false });
  });
  it("image default has empty src", () => {
    expect(defaultAttrsFor("image")).toMatchObject({ src: "" });
  });
  it("embed default has empty provider+url", () => {
    expect(defaultAttrsFor("embed")).toMatchObject({ provider: "", url: "" });
  });
  it("toggle defaults to open=true", () => {
    expect(defaultAttrsFor("toggle")).toEqual({ open: true });
  });
});

describe("@weaver/core / image block", () => {
  it("inserts as a leaf with hasInline=false", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "image",
      attrs: { src: "https://example.com/cat.png", alt: "cat" },
    });
    const b = getBlock(editor, id);
    expect(b?.kind).toBe<BlockKind>("image");
    expect(b?.hasInline).toBe(false);
    expect(b?.attrs).toMatchObject({
      src: "https://example.com/cat.png",
      alt: "cat",
    });
  });

  it("can update its caption via block.setAttr", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "image",
      attrs: { src: "x" },
    });
    editor.commands.block.setAttr({
      blockId: id,
      key: "caption",
      value: "Fig. 1",
    });
    expect(getBlock(editor, id)?.attrs).toMatchObject({
      src: "x",
      caption: "Fig. 1",
    });
  });

  it("refuses inline text operations", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "image",
      attrs: { src: "x" },
    });
    // text.insertTab guards against non-inline blocks; toggleMark / clearMarks
    // are silent no-ops because the block has no LoroText container.
    expect(() =>
      editor.commands.text.insertTab({ blockId: id, offset: 0 }),
    ).toThrow();
    expect(editor.commands.text.length(id)).toBe(0);
    expect(editor.commands.text.read(id)).toBe("");
  });
});

describe("@weaver/core / embed block", () => {
  it("inserts with provider/url attrs", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "embed",
      attrs: {
        provider: "youtube",
        url: "https://youtu.be/abc",
        sandbox: true,
      },
    });
    const b = getBlock(editor, id);
    expect(b?.kind).toBe<BlockKind>("embed");
    expect(b?.hasInline).toBe(false);
    expect(b?.attrs).toMatchObject({
      provider: "youtube",
      url: "https://youtu.be/abc",
      sandbox: true,
    });
  });
});

describe("@weaver/core / toggle block", () => {
  it("is a container with inline summary text", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "toggle",
      attrs: { open: false },
    });
    editor.commands.text.insert({
      blockId: id,
      offset: 0,
      value: "Summary",
    });
    // Add a paragraph child inside the toggle.
    editor.commands.block.insert({
      parentId: id,
      index: 0,
      kind: "paragraph",
    });
    const b = getBlock(editor, id);
    expect(b?.kind).toBe<BlockKind>("toggle");
    expect(b?.hasInline).toBe(true);
    expect(b?.attrs).toMatchObject({ open: false });
    expect(b?.childIds.length).toBe(1);
    expect(editor.commands.text.read(id)).toBe("Summary");
  });

  it("supports toggling open/closed via block.setAttr", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "toggle",
    });
    expect(getBlock(editor, id)?.attrs).toMatchObject({ open: true });
    editor.commands.block.setAttr({ blockId: id, key: "open", value: false });
    expect(getBlock(editor, id)?.attrs).toMatchObject({ open: false });
  });
});

describe("@weaver/core / table family", () => {
  it("builds a 2x2 table tree with header cells", () => {
    const { editor, root } = setup();
    const tableId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "table",
      attrs: { columns: 2 },
    });
    const row1 = editor.commands.block.insert({
      parentId: tableId,
      index: 0,
      kind: "table-row",
    });
    const row2 = editor.commands.block.insert({
      parentId: tableId,
      index: 1,
      kind: "table-row",
    });
    const cells = [
      editor.commands.block.insert({
        parentId: row1,
        index: 0,
        kind: "table-cell",
        attrs: { header: true },
      }),
      editor.commands.block.insert({
        parentId: row1,
        index: 1,
        kind: "table-cell",
        attrs: { header: true },
      }),
      editor.commands.block.insert({
        parentId: row2,
        index: 0,
        kind: "table-cell",
      }),
      editor.commands.block.insert({
        parentId: row2,
        index: 1,
        kind: "table-cell",
      }),
    ];
    editor.commands.text.insert({
      blockId: cells[0]!,
      offset: 0,
      value: "Name",
    });
    editor.commands.text.insert({
      blockId: cells[1]!,
      offset: 0,
      value: "Age",
    });
    editor.commands.text.insert({
      blockId: cells[2]!,
      offset: 0,
      value: "Ada",
    });
    editor.commands.text.insert({ blockId: cells[3]!, offset: 0, value: "36" });

    const table = getBlock(editor, tableId);
    expect(table?.kind).toBe<BlockKind>("table");
    expect(table?.hasInline).toBe(false);
    expect(getChildren(editor, tableId)).toEqual([row1, row2]);
    expect(getChildren(editor, row1)).toHaveLength(2);
    expect(getBlock(editor, cells[0]!)?.attrs).toMatchObject({ header: true });
    expect(getBlock(editor, cells[2]!)?.hasInline).toBe(true);
    expect(editor.commands.text.read(cells[2]!)).toBe("Ada");
  });

  it("table-row has no inline text", () => {
    const { editor, root } = setup();
    const tableId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "table",
    });
    const rowId = editor.commands.block.insert({
      parentId: tableId,
      index: 0,
      kind: "table-row",
    });
    expect(getBlock(editor, rowId)?.hasInline).toBe(false);
    expect(editor.commands.text.length(rowId)).toBe(0);
  });
});

describe("@weaver/core / divider edges", () => {
  it("is a leaf block with hasInline=false", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "divider",
    });
    const b = getBlock(editor, id);
    expect(b?.kind).toBe<BlockKind>("divider");
    expect(b?.hasInline).toBe(false);
    expect(editor.commands.text.length(id)).toBe(0);
  });

  it("can be deleted leaving siblings intact", () => {
    const { editor, root } = setup();
    const id = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "divider",
    });
    editor.commands.block.insert({
      parentId: root,
      index: 2,
      kind: "paragraph",
    });
    editor.commands.block.delete({ blockId: id });
    const kinds = getChildren(editor, root).map(
      (cid) => getBlock(editor, cid)?.kind,
    );
    expect(kinds).toEqual(["paragraph", "paragraph"]);
  });

  it("deleteRange across a divider merges the surrounding paragraphs", () => {
    const { editor, root } = setup();
    const firstId = getChildren(editor, root)[0]!;
    editor.commands.text.insert({
      blockId: firstId,
      offset: 0,
      value: "before",
    });
    const dividerId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "divider",
    });
    const afterId = editor.commands.block.insert({
      parentId: root,
      index: 2,
      kind: "paragraph",
    });
    editor.commands.text.insert({
      blockId: afterId,
      offset: 0,
      value: "after",
    });
    editor.commands.selection.set({
      anchor: { blockId: firstId, offset: 6 },
      focus: { blockId: afterId, offset: 0 },
    });
    editor.commands.selection.deleteRange();
    // The divider sits between the merged endpoints; selection.deleteRange
    // works by merging touched blocks into the anchor block. The intermediate
    // divider (no inline text) gets removed via the merge path.
    expect(getChildren(editor, root)).not.toContain(dividerId);
    expect(editor.commands.text.read(firstId)).toBe("beforeafter");
  });
});
