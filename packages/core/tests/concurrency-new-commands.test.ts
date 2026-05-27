/**
 * CRDT-tricky tests for the v1 command-bus additions: `block.move`,
 * `block.setAttr`, `text.insertTab`. Mirrors the shape of `concurrency.test.ts`
 * — two peers, each making an edit, verify convergence.
 */
import { describe, expect, it } from "vitest";
import {
  createEditor,
  getBlock,
  getChildren,
  rootId,
  type Editor,
} from "../src/index.js";

const syncBoth = (a: Editor, b: Editor): void => {
  a.doc.import(b.doc.export({ mode: "update" }));
  b.doc.import(a.doc.export({ mode: "update" }));
};

describe("@weaver/core / concurrency / block.setAttr", () => {
  it("LWW-style: concurrent setAttr on the same key converges on both peers", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);
    const aId = getChildren(a, rootId(a))[0]!;
    a.commands.block.transform({
      blockId: aId,
      newKind: "heading",
      attrs: { level: 1 },
    });
    syncBoth(a, b);
    a.commands.block.setAttr({ blockId: aId, key: "level", value: 2 });
    b.commands.block.setAttr({ blockId: aId, key: "level", value: 3 });
    syncBoth(a, b);
    // Convergence: both peers see the same final attrs.
    expect(getBlock(a, aId)?.attrs).toEqual(getBlock(b, aId)?.attrs);
    a.dispose();
    b.dispose();
  });

  it("setAttr on different keys both survive — per-key LWW convergence", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);
    const aId = getChildren(a, rootId(a))[0]!;
    a.commands.block.setAttr({ blockId: aId, key: "align", value: "center" });
    b.commands.block.setAttr({ blockId: aId, key: "color", value: "red" });
    syncBoth(a, b);
    // attrs are stored in a per-key LoroMap container; concurrent writes
    // to different keys converge with both values surviving (ADR 0003).
    const merged = getBlock(a, aId)?.attrs as Record<string, unknown>;
    expect(merged).toMatchObject({ align: "center", color: "red" });
    expect(getBlock(b, aId)?.attrs).toEqual(merged);
    a.dispose();
    b.dispose();
  });
});

describe("@weaver/core / concurrency / text.insertTab", () => {
  it("two peers each inserting a tab at the same offset both survive", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);
    const aId = getChildren(a, rootId(a))[0]!;
    a.commands.text.insert({ blockId: aId, offset: 0, value: "abc" });
    syncBoth(a, b);
    a.commands.text.insertTab({ blockId: aId, offset: 1 });
    b.commands.text.insertTab({ blockId: aId, offset: 2 });
    syncBoth(a, b);
    expect(a.commands.text.read(aId)).toBe(b.commands.text.read(aId));
    expect(a.commands.text.read(aId)).toContain("\t");
    // Both tabs survive.
    const tabs = a.commands.text.read(aId).split("").filter((c) => c === "\t");
    expect(tabs).toHaveLength(2);
    a.dispose();
    b.dispose();
  });
});

describe("@weaver/core / concurrency / block.move", () => {
  it("move + delete on the same block converges (delete-wins or move-wins consistently)", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);
    a.commands.block.insert({
      parentId: rootId(a),
      index: 1,
      kind: "paragraph",
    });
    a.commands.block.insert({
      parentId: rootId(a),
      index: 2,
      kind: "paragraph",
    });
    syncBoth(a, b);
    const aKids = getChildren(a, rootId(a));
    a.commands.block.move({
      blockId: aKids[2]!,
      newParentId: aKids[0]!,
      newIndex: 0,
    });
    b.commands.block.delete({ blockId: aKids[2]! });
    syncBoth(a, b);
    // Verify convergence — JSON shapes match regardless of who wins.
    expect(JSON.stringify(a.doc.toJSON())).toBe(
      JSON.stringify(b.doc.toJSON()),
    );
    a.dispose();
    b.dispose();
  });
});
