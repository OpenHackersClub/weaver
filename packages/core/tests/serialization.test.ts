import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createEditor, getChildren, rootId } from "../src/index.js";

/**
 * Serialization tests against the spec in `specs/block-model.md` and the
 * Lexical-parity row in §6 ("toJSON / exportSnapshot / round-trip").
 */

describe("@weaver/core / serialization — toJSON debug-friendly shape", () => {
  it("doc.toJSON exposes the content tree with typed, text-bearing blocks", () => {
    const editor = createEditor();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    editor.commands.text.insert({ blockId: firstId, offset: 0, value: "hello" });
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    // Assert against the parsed structure, not a substring of the blob — so a
    // stray "heading" anywhere can't pass this. The content tree is keyed by
    // the "content" container (see editor.ts TREE_NAME).
    const json = editor.doc.toJSON() as {
      content: ReadonlyArray<{
        meta?: { kind?: string };
        data?: { kind?: string };
      }>;
    };
    expect(Array.isArray(json.content)).toBe(true);
    expect(json.content).toHaveLength(2);
    const kindOf = (n: { meta?: { kind?: string }; data?: { kind?: string } }) =>
      n.meta?.kind ?? n.data?.kind;
    expect(kindOf(json.content[0]!)).toBe("paragraph");
    expect(kindOf(json.content[1]!)).toBe("heading");
    expect(JSON.stringify(json.content[0])).toContain("hello");
    editor.dispose();
  });

  it("text.toDelta surfaces marks as attributes in delta operations", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "hello", attributes: { bold: true } },
    ]);
    editor.dispose();
  });
});

describe("@weaver/core / serialization — Loro snapshot round-trip", () => {
  it("an exported binary snapshot can be imported into a fresh doc with equal toJSON", () => {
    const a = createEditor();
    const aRoot = rootId(a);
    const aFirst = getChildren(a, aRoot)[0]!;
    a.commands.text.insert({ blockId: aFirst, offset: 0, value: "alpha" });
    a.commands.block.insert({
      parentId: aRoot,
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    const aSecond = getChildren(a, aRoot)[1]!;
    a.commands.text.insert({ blockId: aSecond, offset: 0, value: "Title" });

    const snapshot = a.doc.export({ mode: "snapshot" });

    const bDoc = new LoroDoc();
    bDoc.import(snapshot);
    expect(JSON.stringify(bDoc.toJSON())).toBe(JSON.stringify(a.doc.toJSON()));
    a.dispose();
    bDoc.free();
  });

  it("a doc imported from update messages converges to the same toJSON", () => {
    const a = createEditor();
    const aRoot = rootId(a);
    const aFirst = getChildren(a, aRoot)[0]!;
    a.commands.text.insert({ blockId: aFirst, offset: 0, value: "alpha" });

    const b = createEditor({ seed: false });
    b.doc.import(a.doc.export({ mode: "update" }));

    expect(JSON.stringify(b.doc.toJSON())).toBe(JSON.stringify(a.doc.toJSON()));
    a.dispose();
    b.dispose();
  });
});
