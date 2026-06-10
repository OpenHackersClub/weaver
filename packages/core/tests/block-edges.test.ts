import { describe, expect, it } from "vitest";
import {
  createEditor,
  getBlock,
  getChildren,
  rootId,
  type BlockKind,
} from "../src/index.js";
import { future } from "./_test-helpers.js";

const seed = (text = "") => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  if (text) editor.commands.text.insert({ blockId: id, offset: 0, value: text });
  return { editor, id };
};

describe("@weaver/core / block.split — edge offsets", () => {
  it("split at offset 0 leaves the original empty and moves all text to the new sibling", () => {
    const { editor, id } = seed("alphabet");
    const newId = editor.commands.block.split({ blockId: id, offset: 0 });
    expect(editor.commands.text.read(id)).toBe("");
    expect(editor.commands.text.read(newId)).toBe("alphabet");
    editor.dispose();
  });

  it("split at offset === length leaves the new sibling empty", () => {
    const { editor, id } = seed("alphabet");
    const newId = editor.commands.block.split({
      blockId: id,
      offset: "alphabet".length,
    });
    expect(editor.commands.text.read(id)).toBe("alphabet");
    expect(editor.commands.text.read(newId)).toBe("");
    editor.dispose();
  });

  it("split clamps offset > length to length", () => {
    const { editor, id } = seed("abc");
    const newId = editor.commands.block.split({ blockId: id, offset: 999 });
    expect(editor.commands.text.read(id)).toBe("abc");
    expect(editor.commands.text.read(newId)).toBe("");
    editor.dispose();
  });

  it("split preserves the source block's kind on both halves", () => {
    const { editor, id } = seed("heading text");
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    const newId = editor.commands.block.split({ blockId: id, offset: 7 });
    expect(getBlock(editor, id)?.kind).toBe<BlockKind>("heading");
    expect(getBlock(editor, newId)?.kind).toBe<BlockKind>("heading");
    editor.dispose();
  });

  it("split preserves the source block's attrs (heading level) on both halves", () => {
    const { editor, id } = seed("Title");
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 3 },
    });
    const newId = editor.commands.block.split({ blockId: id, offset: 3 });
    expect(getBlock(editor, id)?.attrs).toMatchObject({ level: 3 });
    expect(getBlock(editor, newId)?.attrs).toMatchObject({ level: 3 });
    editor.dispose();
  });
});

describe("@weaver/core / block.merge — edge cases", () => {
  it("merging into an empty prev still concatenates the next's text", () => {
    const editor = createEditor();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    const secondId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: "hello" });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(1);
    expect(editor.commands.text.read(kids[0]!)).toBe("hello");
    editor.dispose();
  });

  it("merging with both blocks empty leaves a single empty block", () => {
    const editor = createEditor();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    const secondId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.block.merge({ prevId: firstId, nextId: secondId });
    expect(getChildren(editor, root)).toHaveLength(1);
    expect(editor.commands.text.read(firstId)).toBe("");
    editor.dispose();
  });

  it("merging a block that has nested children adopts them under prev (no data loss)", () => {
    // Regression: `tree.delete(next)` removes the whole subtree, so merging a
    // block whose children were nested (via indent) silently destroyed them.
    const editor = createEditor();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    editor.commands.text.insert({ blockId: firstId, offset: 0, value: "first" });
    const secondId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: secondId, offset: 0, value: "second" });
    const childId = editor.commands.block.insert({
      parentId: secondId,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    editor.commands.text.insert({ blockId: childId, offset: 0, value: "nested" });

    editor.commands.block.merge({ prevId: firstId, nextId: secondId });

    expect(editor.commands.text.read(firstId)).toBe("firstsecond");
    // The nested child survives, reparented under the merge target.
    expect(getChildren(editor, firstId)).toEqual([childId]);
    expect(editor.commands.text.read(childId)).toBe("nested");
    editor.dispose();
  });

  it("merge adoption appends after prev's existing children, in order", () => {
    const editor = createEditor();
    const root = rootId(editor);
    const firstId = getChildren(editor, root)[0]!;
    const existingChild = editor.commands.block.insert({
      parentId: firstId,
      index: 0,
      kind: "paragraph",
      attrs: {},
    });
    const secondId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    const adoptedA = editor.commands.block.insert({
      parentId: secondId,
      index: 0,
      kind: "paragraph",
      attrs: {},
    });
    const adoptedB = editor.commands.block.insert({
      parentId: secondId,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });

    editor.commands.block.merge({ prevId: firstId, nextId: secondId });

    expect(getChildren(editor, firstId)).toEqual([
      existingChild,
      adoptedA,
      adoptedB,
    ]);
    editor.dispose();
  });
});

describe("@weaver/core / block.transform — kind & attr changes", () => {
  it("transforming paragraph→heading and back preserves the text", () => {
    const { editor, id } = seed("Some text");
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    editor.commands.block.transform({
      blockId: id,
      newKind: "paragraph",
      attrs: {},
    });
    expect(editor.commands.text.read(id)).toBe("Some text");
    expect(getBlock(editor, id)?.kind).toBe<BlockKind>("paragraph");
    editor.dispose();
  });

  it("transforming to to-do initializes the `checked: false` attr", () => {
    const { editor, id } = seed("buy milk");
    editor.commands.block.transform({ blockId: id, newKind: "to-do" });
    expect(getBlock(editor, id)?.attrs).toMatchObject({ checked: false });
    editor.dispose();
  });

  it("transforming to a kind already in use is idempotent — text & attrs survive", () => {
    const { editor, id } = seed("alpha");
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    expect(editor.commands.text.read(id)).toBe("alpha");
    expect(getBlock(editor, id)?.attrs).toMatchObject({ level: 2 });
    editor.dispose();
  });
});

describe("@weaver/core / block.delete — root guard", () => {
  it("deleting the very last block under root re-seeds an empty paragraph", () => {
    // Lexical forbids an empty root; weaver mirrors that invariant so the
    // editing surface never has zero blocks (`block.delete` re-seeds).
    const editor = createEditor();
    const root = rootId(editor);
    const only = getChildren(editor, root)[0]!;
    editor.commands.block.delete({ blockId: only });
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(1);
    expect(getBlock(editor, kids[0]!)?.kind).toBe<BlockKind>("paragraph");
    expect(editor.commands.text.read(kids[0]!)).toBe("");
    editor.dispose();
  });

  it("deleting a non-existent block id is a silent no-op", () => {
    const editor = createEditor();
    expect(() =>
      editor.commands.block.delete({ blockId: "bogus" }),
    ).not.toThrow();
    expect(getChildren(editor, rootId(editor))).toHaveLength(1);
    editor.dispose();
  });
});

describe("@weaver/core / block.indent / block.outdent (list nesting)", () => {
  // Use `seed: false` so root has exactly the blocks the test sets up — no
  // stray seed paragraph to widen the expected tree.
  it("indent moves a block to become a child of its previous sibling", () => {
    // specs/lexical-parity.md §3: block.indent(blockId) / block.outdent(blockId).
    // Currently no such surface — these tests are TDD targets.
    const editor = createEditor({ seed: false });
    const root = rootId(editor);
    const first = editor.commands.block.insert({
      parentId: root,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    const second = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "bullet-list-item",
      attrs: {},
    });
    future(editor).commands.block.indent({ blockId: second });
    expect(getChildren(editor, root)).toEqual([first]);
    expect(getChildren(editor, first)).toEqual([second]);
    editor.dispose();
  });

  it("indent on the first child has no effect (no preceding sibling to nest under)", () => {
    const editor = createEditor({ seed: false });
    const root = rootId(editor);
    const only = editor.commands.block.insert({
      parentId: root,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    const result = future(editor).commands.block.indent({ blockId: only });
    expect(result).toBe(false);
    expect(getChildren(editor, root)).toEqual([only]);
    editor.dispose();
  });

  it("outdent unnests a deeply nested item back to the parent's level", () => {
    const editor = createEditor({ seed: false });
    const root = rootId(editor);
    const a = editor.commands.block.insert({
      parentId: root,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    const b = editor.commands.block.insert({
      parentId: a,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    future(editor).commands.block.outdent({ blockId: b });
    expect(getChildren(editor, root)).toEqual([a, b]);
    expect(getChildren(editor, a)).not.toContain(b);
    editor.dispose();
  });

  it("outdent on a root-level block has no effect (already at top level)", () => {
    const editor = createEditor({ seed: false });
    const root = rootId(editor);
    const only = editor.commands.block.insert({
      parentId: root,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    const result = future(editor).commands.block.outdent({ blockId: only });
    expect(result).toBe(false);
    editor.dispose();
  });

  it("indent → outdent restores the original tree shape", () => {
    const editor = createEditor({ seed: false });
    const root = rootId(editor);
    const a = editor.commands.block.insert({
      parentId: root,
      index: 0,
      kind: "bullet-list-item",
      attrs: {},
    });
    const b = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "bullet-list-item",
      attrs: {},
    });
    future(editor).commands.block.indent({ blockId: b });
    future(editor).commands.block.outdent({ blockId: b });
    // Tree shape round-trips: b is back as a's sibling, neither nested.
    expect(getChildren(editor, root)).toEqual([a, b]);
    expect(getChildren(editor, a)).toEqual([]);
    editor.dispose();
  });
});

describe("@weaver/core / editor.clear, setEditable, focus, blur", () => {
  it("editor.clear() replaces all content with the empty-doc template", () => {
    const editor = createEditor();
    const root = rootId(editor);
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    editor.commands.text.insert({
      blockId: getChildren(editor, root)[0]!,
      offset: 0,
      value: "stuff",
    });
    future(editor).clear();
    const kids = getChildren(editor, root);
    expect(kids).toHaveLength(1);
    expect(getBlock(editor, kids[0]!)?.kind).toBe<BlockKind>("paragraph");
    expect(editor.commands.text.read(kids[0]!)).toBe("");
    editor.dispose();
  });

  it("setEditable(false) flips the editable flag and isEditable() reads it back", () => {
    const editor = createEditor();
    future(editor).setEditable(false);
    expect(future(editor).isEditable()).toBe(false);
    future(editor).setEditable(true);
    expect(future(editor).isEditable()).toBe(true);
    editor.dispose();
  });
});

describe("@weaver/core / per-command commit batching", () => {
  it("each command produces exactly one doc.subscribe batch", () => {
    const editor = createEditor();
    const root = rootId(editor);
    let batches = 0;
    const unsub = editor.doc.subscribe(() => {
      batches += 1;
    });
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    editor.commands.text.insert({
      blockId: getChildren(editor, root)[0]!,
      offset: 0,
      value: "x",
    });
    unsub();
    // Loro batches subscribe callbacks; we accept any small count, but
    // multiple commands must NOT collapse into a single batch (which would
    // break per-step undo grouping).
    expect(batches).toBeGreaterThanOrEqual(2);
    editor.dispose();
  });

  it("commands carry the editor's `origin` on the batch", () => {
    const editor = createEditor({ origin: "agent" });
    const root = rootId(editor);
    const origins: Array<string | undefined> = [];
    const unsub = editor.doc.subscribe((batch) => origins.push(batch.origin));
    editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "paragraph",
      attrs: {},
    });
    unsub();
    expect(origins).toContain("agent");
    editor.dispose();
  });
});
