import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId, type Editor } from "@weaver/core";
import {
  findBlockElement,
  reconcileTopLevel,
  renderBlockElement,
  tagFor,
  wrapWithMarks,
} from "../src/dom-mapper.js";

/**
 * Direct dom-mapper tests — no bridge, no events. These confirm the
 * imperative DOM patcher produces a stable, identity-preserving DOM.
 */

let host: HTMLElement;
let editor: Editor;

beforeEach(() => {
  editor = createEditor();
  host = document.createElement("div");
  document.body.appendChild(host);
  reconcileTopLevel(editor, host);
});
afterEach(() => {
  host.remove();
  editor.dispose();
});

describe("@weaver/dom / tagFor", () => {
  it("heading → h1..h6 with clamping", () => {
    expect(tagFor("heading", 1)).toBe("h1");
    expect(tagFor("heading", 3)).toBe("h3");
    expect(tagFor("heading", 6)).toBe("h6");
    expect(tagFor("heading", 10)).toBe("h6");
    expect(tagFor("heading", 0)).toBe("h1");
  });

  it("quote → blockquote, lists → li, paragraph → p, to-do → li", () => {
    expect(tagFor("quote")).toBe("blockquote");
    expect(tagFor("bullet-list-item")).toBe("li");
    expect(tagFor("numbered-list-item")).toBe("li");
    expect(tagFor("to-do")).toBe("li");
    expect(tagFor("paragraph")).toBe("p");
  });
});

describe("@weaver/dom / reconcileTopLevel", () => {
  it("renders one <p> for the seed paragraph", () => {
    expect(host.querySelectorAll("[data-block-id]")).toHaveLength(1);
    expect(host.querySelector("p")).not.toBeNull();
  });

  it("appends a heading and reconciles in document order", () => {
    editor.commands.block.insert({
      parentId: rootId(editor),
      index: 1,
      kind: "heading",
      attrs: { level: 2 },
    });
    reconcileTopLevel(editor, host);
    const els = host.querySelectorAll("[data-block-id]");
    expect(els).toHaveLength(2);
    expect(els[0]!.tagName.toLowerCase()).toBe("p");
    expect(els[1]!.tagName.toLowerCase()).toBe("h2");
  });

  it("preserves element identity for unchanged blocks across reconciles (fast-path)", () => {
    const before = host.querySelector("[data-block-id]");
    reconcileTopLevel(editor, host);
    reconcileTopLevel(editor, host);
    const after = host.querySelector("[data-block-id]");
    expect(after).toBe(before);
  });

  it("preserves the Text node identity across single-keystroke reconciles", () => {
    // Hot path: typing one character should NOT replace the text node, since
    // doing so wipes the live DOM selection. See `packages/dom/src/dom-mapper.ts`
    // `isSinglePlainTextDelta` fast path.
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "abc" });
    reconcileTopLevel(editor, host);
    const el = host.querySelector("[data-block-id]") as HTMLElement;
    const textNode = el.firstChild;
    editor.commands.text.insert({ blockId: id, offset: 3, value: "d" });
    reconcileTopLevel(editor, host);
    expect(el.firstChild).toBe(textNode);
    expect(el.textContent).toBe("abcd");
  });

  it("removes a block element when its block is deleted", () => {
    const root = rootId(editor);
    const newId = editor.commands.block.insert({
      parentId: root,
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    reconcileTopLevel(editor, host);
    editor.commands.block.delete({ blockId: newId });
    reconcileTopLevel(editor, host);
    expect(host.querySelectorAll("[data-block-id]")).toHaveLength(1);
  });

  it("swaps the tag when a block's kind changes (paragraph → heading)", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 1 },
    });
    reconcileTopLevel(editor, host);
    const el = findBlockElement(host, id);
    expect(el?.tagName.toLowerCase()).toBe("h1");
  });

  it("reflects the heading level attr on a data-level attribute", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 3 },
    });
    reconcileTopLevel(editor, host);
    const el = findBlockElement(host, id);
    expect(el?.getAttribute("data-level")).toBe("3");
  });

  it("removes the data-level attribute when transformed away from heading", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.block.transform({
      blockId: id,
      newKind: "heading",
      attrs: { level: 2 },
    });
    reconcileTopLevel(editor, host);
    editor.commands.block.transform({
      blockId: id,
      newKind: "paragraph",
      attrs: {},
    });
    reconcileTopLevel(editor, host);
    const el = findBlockElement(host, id);
    expect(el?.hasAttribute("data-level")).toBe(false);
  });
});

describe("@weaver/dom / mark rendering", () => {
  it("renders a `<strong>` for a bold run", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    reconcileTopLevel(editor, host);
    const el = renderBlockElement(editor, id);
    expect(el.querySelector("strong")?.textContent).toBe("hello");
  });

  it("renders an `<em>` for an italic run", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hello" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "italic",
    });
    const el = renderBlockElement(editor, id);
    expect(el.querySelector("em")?.textContent).toBe("hello");
  });

  it("renders an `<a href=...>` for a link-marked run", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "docs" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "link",
      value: "https://example.com",
    });
    const el = renderBlockElement(editor, id);
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.textContent).toBe("docs");
  });

  it("renders a `<code>` for an inline-code run", () => {
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "x" });
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 1 },
      mark: "code",
    });
    const el = renderBlockElement(editor, id);
    expect(el.querySelector("code")?.textContent).toBe("x");
  });
});

describe("@weaver/dom / agent-pending mark rendering", () => {
  it("wraps an agent-pending run in span.weaver-agent-pending[data-agent]", () => {
    const node = wrapWithMarks(document, "drafting...", {
      "agent-pending": "agent-1",
    });
    expect(node).toBeInstanceOf(HTMLSpanElement);
    const span = node as HTMLSpanElement;
    expect(span.classList.contains("weaver-agent-pending")).toBe(true);
    expect(span.getAttribute("data-agent")).toBe("agent-1");
    expect(span.textContent).toBe("drafting...");
  });

  it("stringifies a non-string agent-pending value into data-agent", () => {
    const node = wrapWithMarks(document, "x", { "agent-pending": 2 });
    expect((node as HTMLElement).getAttribute("data-agent")).toBe("2");
  });

  it("places agent-pending outside other marks (it is the outermost layer)", () => {
    const node = wrapWithMarks(document, "bold draft", {
      bold: true,
      "agent-pending": "agent-2",
    });
    const span = node as HTMLSpanElement;
    expect(span.classList.contains("weaver-agent-pending")).toBe(true);
    expect(span.querySelector("strong")?.textContent).toBe("bold draft");
  });

  it("does not wrap when agent-pending is absent or falsy", () => {
    const plain = wrapWithMarks(document, "hi", {});
    expect(plain).toBeInstanceOf(Text);
    const falsy = wrapWithMarks(document, "hi", { "agent-pending": "" });
    expect(falsy).toBeInstanceOf(Text);
  });
});
