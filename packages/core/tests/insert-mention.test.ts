/**
 * `text.insertMention` — the atomic tail of the Notion-style @-mention flow:
 * replace the typed `@query` trigger text with a marked mention chip plus a
 * trailing space, in ONE commit / ONE undo step, and emit `MentionCreated`.
 */
import { describe, expect, it } from "vitest";
import {
  createEditor,
  getChildren,
  rootId,
  type Editor,
  type MentionCreatedEvent,
} from "../src/index.js";

const setup = (
  value = "say hi to @ad",
): { editor: Editor; id: string } => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  editor.commands.text.insert({ blockId: id, offset: 0, value });
  return { editor, id };
};

describe("@weaver/core / text.insertMention", () => {
  it("replaces the trigger text with a marked label plus trailing space", () => {
    const { editor, id } = setup(); // "say hi to @ad", trigger at [10, 13)
    const marked = editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada Lovelace", kind: "user" },
    });
    expect(editor.commands.text.read(id)).toBe("say hi to @Ada Lovelace ");
    expect(marked).toEqual({ start: 10, end: 23 });
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "say hi to " },
      {
        insert: "@Ada Lovelace",
        attributes: {
          mention: { userId: "user:ada", label: "@Ada Lovelace", kind: "user" },
        },
      },
      { insert: " " },
    ]);
  });

  it("keeps an existing @ prefix on the label without doubling it", () => {
    const { editor, id } = setup();
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "agent-1", label: "@Agent 1", kind: "agent" },
    });
    expect(editor.commands.text.read(id)).toBe("say hi to @Agent 1 ");
  });

  it("a collapsed range (start === end) inserts without deleting", () => {
    const { editor, id } = setup("hello ");
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 6, end: 6 },
      principal: { id: "user:grace", label: "Grace" },
    });
    expect(editor.commands.text.read(id)).toBe("hello @Grace ");
  });

  it("is a single undo step (one commit): undo restores the trigger text", () => {
    const { editor, id } = setup();
    editor.commands.history.flushMergeWindow();
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada Lovelace" },
    });
    expect(editor.commands.history.undo()).toBe(true);
    expect(editor.commands.text.read(id)).toBe("say hi to @ad");
  });

  it("emits MentionCreated with the marked range and principal", () => {
    const { editor, id } = setup();
    const seen: MentionCreatedEvent[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(...events));
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada Lovelace", kind: "user" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      _tag: "MentionCreated",
      blockId: id,
      range: { start: 10, end: 23 },
      principal: { id: "user:ada", label: "@Ada Lovelace", kind: "user" },
      origin: "user",
    });
  });

  it("typing after the chip does not extend the mention (expand: none)", () => {
    const { editor, id } = setup();
    const marked = editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada" },
    });
    editor.commands.text.insert({
      blockId: id,
      offset: marked.end + 1,
      value: "ok",
    });
    const delta = editor.commands.text.toDelta(id) as ReadonlyArray<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const tail = delta[delta.length - 1]!;
    expect(tail.insert).toBe(" ok");
    expect(tail.attributes?.["mention"]).toBeUndefined();
  });

  it("redo after undo restores both the text and the mention mark, without re-emitting", () => {
    const { editor, id } = setup();
    const seen: MentionCreatedEvent[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(...events));
    editor.commands.history.flushMergeWindow();
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada" },
    });
    expect(editor.commands.history.undo()).toBe(true);
    expect(editor.commands.history.redo()).toBe(true);
    expect(editor.commands.text.toDelta(id)).toEqual([
      { insert: "say hi to " },
      {
        insert: "@Ada",
        attributes: { mention: { userId: "user:ada", label: "@Ada" } },
      },
      { insert: " " },
    ]);
    // Events fire at command time only — undo/redo replay ops, not commands.
    expect(seen).toHaveLength(1);
  });

  it("a mention inside a styled run inherits the surrounding mark (Notion-like)", () => {
    // Pinned: the label inherits expand:"after" marks spanning the trigger.
    const { editor, id } = setup();
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 13 },
      mark: "bold",
    });
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 10, end: 13 },
      principal: { id: "user:ada", label: "Ada" },
    });
    const delta = editor.commands.text.toDelta(id) as ReadonlyArray<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const chip = delta.find((r) => r.attributes?.["mention"]);
    expect(chip?.insert).toBe("@Ada");
    expect(chip?.attributes?.["bold"]).toBe(true);
  });

  it("clamps an out-of-bounds range to the text length", () => {
    const { editor, id } = setup("hi");
    editor.commands.text.insertMention({
      blockId: id,
      range: { start: 1, end: 99 },
      principal: { id: "user:ada", label: "Ada" },
    });
    expect(editor.commands.text.read(id)).toBe("h@Ada ");
  });

  it("throws for a block without inline text", () => {
    const { editor } = setup();
    const dividerId = editor.commands.block.insert({
      parentId: rootId(editor),
      index: 1,
      kind: "divider",
    });
    expect(() =>
      editor.commands.text.insertMention({
        blockId: dividerId,
        range: { start: 0, end: 0 },
        principal: { id: "user:ada", label: "Ada" },
      }),
    ).toThrow(/no inline text/);
  });

  it("rejects an empty principal id", () => {
    const { editor, id } = setup();
    expect(() =>
      editor.commands.text.insertMention({
        blockId: id,
        range: { start: 10, end: 13 },
        principal: { id: "", label: "Ada" },
      }),
    ).toThrow(/mention mark/);
  });
});
