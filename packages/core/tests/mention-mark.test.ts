/**
 * Inline `mention` mark — the v1-minimal realization of the Lexical
 * TypeaheadMenuPlugin's mention surface (`specs/lexical-parity.md` §1 row
 * "TypeaheadMenuPlugin"). v1 ships mention as an inline mark over a label
 * run; future iterations can promote it to a first-class inline-mode block
 * kind without breaking these tests.
 */
import { describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId } from "../src/index.js";

const setup = () => {
  const editor = createEditor();
  const root = rootId(editor);
  const id = getChildren(editor, root)[0]!;
  editor.commands.text.insert({
    blockId: id,
    offset: 0,
    value: "hi @ada",
  });
  return { editor, id };
};

describe("@weaver/core / marks / mention", () => {
  it("applies a mention mark over a typed range with userId+label", () => {
    const { editor, id } = setup();
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
      value: { userId: "u-1", label: "@ada" },
    });
    const delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([
      { insert: "hi " },
      {
        insert: "@ada",
        attributes: { mention: { userId: "u-1", label: "@ada" } },
      },
    ]);
  });

  it("rejects an empty mention payload", () => {
    const { editor, id } = setup();
    expect(() =>
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 3, end: 7 },
        mark: "mention",
      }),
    ).toThrow(/mention mark/);
  });

  it("rejects a partial mention payload (missing label)", () => {
    const { editor, id } = setup();
    expect(() =>
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 3, end: 7 },
        mark: "mention",
        value: { userId: "u-1" },
      }),
    ).toThrow(/mention mark/);
  });

  it("rejects a payload with empty-string fields", () => {
    const { editor, id } = setup();
    expect(() =>
      editor.commands.text.toggleMark({
        blockId: id,
        range: { start: 3, end: 7 },
        mark: "mention",
        value: { userId: "", label: "@ada" },
      }),
    ).toThrow(/mention mark/);
  });

  it("typing at the trailing edge does NOT extend the mention (expand: none)", () => {
    const { editor, id } = setup();
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
      value: { userId: "u-1", label: "@ada" },
    });
    // Insert a space after the mention; the new char must not inherit the mark.
    editor.commands.text.insert({
      blockId: id,
      offset: 7,
      value: " hello",
    });
    const delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([
      { insert: "hi " },
      {
        insert: "@ada",
        attributes: { mention: { userId: "u-1", label: "@ada" } },
      },
      { insert: " hello" },
    ]);
  });

  it("clearMarks removes a mention along with other marks", () => {
    const { editor, id } = setup();
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
      value: { userId: "u-1", label: "@ada" },
    });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "bold",
    });
    editor.commands.text.clearMarks({
      blockId: id,
      range: { start: 0, end: 7 },
    });
    const delta = editor.commands.text.toDelta(id);
    expect(delta).toEqual([{ insert: "hi @ada" }]);
  });

  it("toggleMark removes the mention when fully covered", () => {
    const { editor, id } = setup();
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
      value: { userId: "u-1", label: "@ada" },
    });
    // A subsequent toggleMark without a fresh value still toggles off, because
    // the range is fully covered by an existing mark — no validation needed.
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
    });
    // Loro may leave two adjacent unmarked runs after a partial unmark; the
    // assertion is that no run carries the `mention` attribute.
    const delta = editor.commands.text.toDelta(id) as ReadonlyArray<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.every((r) => !r.attributes?.mention)).toBe(true);
    expect(delta.map((r) => r.insert ?? "").join("")).toBe("hi @ada");
  });
});
