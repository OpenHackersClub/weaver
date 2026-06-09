import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChildren, rootId, type ClipboardPayload } from "@weaver/core";
import { writeDomSelection } from "../src/selection-mapper.js";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

/**
 * Clipboard bridge tests — specs/lexical-parity.md §3 (COPY / CUT / PASTE).
 *
 * The bridge owns the ClipboardEvent half of the parity row: `copy` / `cut`
 * serialize the DOM selection through `commands.clipboard` onto the event's
 * clipboardData (plain text + the structured `application/x-weaver` flavor);
 * `paste` prefers the structured flavor and falls back to plain text. jsdom
 * has no DataTransfer, so a stub records the flavors.
 */

const WEAVER_MIME = "application/x-weaver";

interface StubClipboardData {
  readonly stored: Map<string, string>;
  getData(type: string): string;
  setData(type: string, value: string): void;
}

const makeClipboardData = (
  initial?: Record<string, string>,
): StubClipboardData => {
  const stored = new Map(Object.entries(initial ?? {}));
  return {
    stored,
    getData: (type) => stored.get(type) ?? "",
    setData: (type, value) => {
      stored.set(type, value);
    },
  };
};

const dispatchClipboard = (
  host: HTMLElement,
  type: "copy" | "cut" | "paste",
  data: StubClipboardData,
): Event => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: data });
  host.dispatchEvent(ev);
  return ev;
};

let f: DomFixture;
beforeEach(() => {
  f = setupDom();
});
afterEach(() => {
  f.destroy();
});

const selectRange = (
  anchor: { blockId: string; offset: number },
  focus: { blockId: string; offset: number },
): void => {
  writeDomSelection(f.host, {
    anchor,
    focus,
    collapsed:
      anchor.blockId === focus.blockId && anchor.offset === focus.offset,
  });
};

describe("@weaver/dom / copy", () => {
  it("writes text/plain and the structured x-weaver flavor for a selection", () => {
    f.type("hello");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 1 }, { blockId: id, offset: 4 });
    const data = makeClipboardData();
    const ev = dispatchClipboard(f.host, "copy", data);
    expect(ev.defaultPrevented).toBe(true);
    expect(data.stored.get("text/plain")).toBe("ell");
    const payload = JSON.parse(data.stored.get(WEAVER_MIME)!) as ClipboardPayload;
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0]!.kind).toBe("paragraph");
    expect(payload.blocks[0]!.delta).toEqual([{ insert: "ell" }]);
    // Copy must not mutate the doc.
    expect(f.blockTexts()).toEqual(["hello"]);
  });

  it("preserves block kinds across a multi-block selection", () => {
    const root = rootId(f.editor);
    const p = getChildren(f.editor, root)[0]!;
    f.editor.commands.text.insert({ blockId: p, offset: 0, value: "hello" });
    const h = f.editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    f.editor.commands.text.insert({ blockId: h, offset: 0, value: "world" });
    f.bridge.rerender();
    selectRange({ blockId: p, offset: 0 }, { blockId: h, offset: 5 });
    const data = makeClipboardData();
    dispatchClipboard(f.host, "copy", data);
    expect(data.stored.get("text/plain")).toBe("hello\nworld");
    const payload = JSON.parse(data.stored.get(WEAVER_MIME)!) as ClipboardPayload;
    expect(payload.blocks.map((b) => b.kind)).toEqual(["paragraph", "heading"]);
  });

  it("does nothing for a collapsed selection", () => {
    f.type("hello");
    const data = makeClipboardData();
    const ev = dispatchClipboard(f.host, "copy", data);
    expect(ev.defaultPrevented).toBe(false);
    expect(data.stored.size).toBe(0);
  });
});

describe("@weaver/dom / cut", () => {
  it("writes the clipboard flavors and removes the selection", () => {
    f.type("hello");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 1 }, { blockId: id, offset: 4 });
    const data = makeClipboardData();
    const ev = dispatchClipboard(f.host, "cut", data);
    expect(ev.defaultPrevented).toBe(true);
    expect(data.stored.get("text/plain")).toBe("ell");
    expect(f.blockTexts()).toEqual(["ho"]);
  });

  it("removes a multi-block selection, merging the endpoints", () => {
    const root = rootId(f.editor);
    const p = getChildren(f.editor, root)[0]!;
    f.editor.commands.text.insert({ blockId: p, offset: 0, value: "hello" });
    const h = f.editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    f.editor.commands.text.insert({ blockId: h, offset: 0, value: "world" });
    f.bridge.rerender();
    selectRange({ blockId: p, offset: 2 }, { blockId: h, offset: 3 });
    const data = makeClipboardData();
    dispatchClipboard(f.host, "cut", data);
    expect(data.stored.get("text/plain")).toBe("llo\nwor");
    expect(f.blockTexts()).toEqual(["held"]);
  });

  it("does nothing for a collapsed selection", () => {
    f.type("hello");
    const data = makeClipboardData();
    const ev = dispatchClipboard(f.host, "cut", data);
    expect(ev.defaultPrevented).toBe(false);
    expect(f.blockTexts()).toEqual(["hello"]);
  });
});

describe("@weaver/dom / paste", () => {
  it("prefers the structured x-weaver flavor over text/plain", () => {
    f.type("AD");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 1 }, { blockId: id, offset: 1 });
    const payload: ClipboardPayload = {
      text: "WRONG",
      blocks: [
        {
          kind: "paragraph",
          attrs: {},
          delta: [{ insert: "bc", attributes: { bold: true } }],
          children: [],
        },
      ],
    };
    const data = makeClipboardData({
      "text/plain": "WRONG",
      [WEAVER_MIME]: JSON.stringify(payload),
    });
    const ev = dispatchClipboard(f.host, "paste", data);
    expect(ev.defaultPrevented).toBe(true);
    expect(f.blockTexts()).toEqual(["AbcD"]);
    expect(f.editor.commands.text.toDelta(id)).toEqual([
      { insert: "A" },
      { insert: "bc", attributes: { bold: true } },
      { insert: "D" },
    ]);
  });

  it("pastes structured multi-block payloads with kinds intact", () => {
    f.type("ABCD");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 2 }, { blockId: id, offset: 2 });
    const payload: ClipboardPayload = {
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
    };
    const data = makeClipboardData({ [WEAVER_MIME]: JSON.stringify(payload) });
    dispatchClipboard(f.host, "paste", data);
    expect(f.blockTexts()).toEqual(["ABxx", "yyCD"]);
    expect(f.blockKinds()).toEqual(["paragraph", "heading"]);
  });

  it("falls back to plain text, splitting on newlines", () => {
    f.type("AB");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 1 }, { blockId: id, offset: 1 });
    const data = makeClipboardData({ "text/plain": "one\ntwo" });
    const ev = dispatchClipboard(f.host, "paste", data);
    expect(ev.defaultPrevented).toBe(true);
    expect(f.blockTexts()).toEqual(["Aone", "twoB"]);
  });

  it("replaces a non-collapsed selection", () => {
    f.type("hello world");
    const id = getChildren(f.editor, rootId(f.editor))[0]!;
    selectRange({ blockId: id, offset: 6 }, { blockId: id, offset: 11 });
    const data = makeClipboardData({ "text/plain": "weaver" });
    dispatchClipboard(f.host, "paste", data);
    expect(f.blockTexts()).toEqual(["hello weaver"]);
  });

  it("ignores a paste with no usable flavor", () => {
    f.type("hello");
    const data = makeClipboardData();
    const ev = dispatchClipboard(f.host, "paste", data);
    expect(ev.defaultPrevented).toBe(true);
    expect(f.blockTexts()).toEqual(["hello"]);
  });

  it("round-trips copy → paste within the editor", () => {
    const root = rootId(f.editor);
    const p = getChildren(f.editor, root)[0]!;
    f.editor.commands.text.insert({ blockId: p, offset: 0, value: "hello" });
    const h = f.editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    f.editor.commands.text.insert({ blockId: h, offset: 0, value: "world" });
    f.bridge.rerender();
    selectRange({ blockId: p, offset: 0 }, { blockId: h, offset: 5 });
    const data = makeClipboardData();
    dispatchClipboard(f.host, "copy", data);
    // Paste at the end of the heading.
    selectRange({ blockId: h, offset: 5 }, { blockId: h, offset: 5 });
    dispatchClipboard(f.host, "paste", data);
    expect(f.blockTexts()).toEqual(["hello", "worldhello", "world"]);
    expect(f.blockKinds()).toEqual(["paragraph", "heading", "heading"]);
  });
});
