import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

/**
 * Markdown-shortcut input flow tests.
 *
 * The only shortcut currently wired in `@weaver/dom/keymap.ts` is heading
 * h1 (the `# ` regex). Lexical's `Markdown.spec.mjs` exercises a much wider
 * set — these tests pin the contract weaver commits to in
 * `specs/lexical-parity.md` §4 (MarkdownShortcutPlugin →
 * `@weaver/plugins-markdown`).
 */

let f: DomFixture;
beforeEach(() => {
  f = setupDom();
});
afterEach(() => {
  f.destroy();
});

describe("@weaver/dom / markdown shortcuts — headings", () => {
  it("`# ` at the start of a paragraph transforms it to heading level 1", () => {
    f.type("# ");
    expect(f.blockKinds()).toEqual(["heading"]);
    const level = f.blockEls()[0]!.getAttribute("data-level");
    expect(level).toBe("1");
  });

  it("`## ` transforms to heading level 2", () => {
    f.type("## ");
    expect(f.blockKinds()).toEqual(["heading"]);
    expect(f.blockEls()[0]!.getAttribute("data-level")).toBe("2");
  });

  it("`### ` transforms to heading level 3", () => {
    f.type("### ");
    expect(f.blockKinds()).toEqual(["heading"]);
    expect(f.blockEls()[0]!.getAttribute("data-level")).toBe("3");
  });

  it("`#### ` transforms to heading level 4", () => {
    f.type("#### ");
    expect(f.blockEls()[0]!.getAttribute("data-level")).toBe("4");
  });

  it("`##### ` transforms to heading level 5", () => {
    f.type("##### ");
    expect(f.blockEls()[0]!.getAttribute("data-level")).toBe("5");
  });

  it("`###### ` transforms to heading level 6", () => {
    f.type("###### ");
    expect(f.blockEls()[0]!.getAttribute("data-level")).toBe("6");
  });

  it("`####### ` (7 hashes) is treated as plain text, not a heading", () => {
    f.type("####### ");
    expect(f.blockKinds()).toEqual(["paragraph"]);
    expect(f.blockTexts()).toEqual(["####### "]);
  });
});

describe("@weaver/dom / markdown shortcuts — block transforms", () => {
  it("`> ` transforms a paragraph to a quote", () => {
    f.type("> ");
    expect(f.blockKinds()).toEqual(["quote"]);
  });

  it("`- ` transforms a paragraph to a bullet list item", () => {
    f.type("- ");
    expect(f.blockKinds()).toEqual(["bullet-list-item"]);
  });

  it("`* ` transforms a paragraph to a bullet list item", () => {
    f.type("* ");
    expect(f.blockKinds()).toEqual(["bullet-list-item"]);
  });

  it("`1. ` transforms a paragraph to a numbered list item", () => {
    f.type("1. ");
    expect(f.blockKinds()).toEqual(["numbered-list-item"]);
  });

  it("`5. ` transforms to a numbered list item", () => {
    f.type("5. ");
    expect(f.blockKinds()).toEqual(["numbered-list-item"]);
    // Whether the start number `5` is captured as a block attr is an open
    // schema question — `numbered-list-item` has no `start` attr today. When
    // that lands, add an attr assertion here.
  });

  it("`[ ] ` transforms a paragraph to an unchecked to-do", () => {
    f.type("[ ] ");
    expect(f.blockKinds()).toEqual(["to-do"]);
  });

  it("`[x] ` transforms a paragraph to a CHECKED to-do", () => {
    f.type("[x] ");
    expect(f.blockKinds()).toEqual(["to-do"]);
  });

  // The next three target the `code` and `divider` block kinds. Both are
  // committed v1 kinds in specs/lexical-parity.md §1 but are NOT yet in
  // `BlockKindSchema` (packages/core/src/block.ts). Turning these green
  // requires extending the schema first (an ADR 0002-adjacent change), then
  // wiring the shortcut — flagged so the implementer knows the scope.
  it("` ``` ` opens a code block", () => {
    // 3 backticks + space; tested separately to avoid template-literal noise.
    f.type("```");
    f.type(" ");
    expect(f.blockKinds()).toEqual(["code"]);
  });

  it("`--- ` inserts a divider", () => {
    f.type("--- ");
    // Either the paragraph becomes a divider, or a divider block is inserted
    // and the paragraph is cleared/removed.
    expect(f.blockKinds()).toContain("divider");
  });

  it("`*** ` inserts a divider", () => {
    f.type("*** ");
    expect(f.blockKinds()).toContain("divider");
  });
});

describe("@weaver/dom / markdown shortcuts — edge cases", () => {
  it("a shortcut only fires at offset 0 — mid-text patterns are literal text", () => {
    f.type("hello # ");
    expect(f.blockKinds()).toEqual(["paragraph"]);
    expect(f.blockTexts()).toEqual(["hello # "]);
  });

  it("a shortcut does not fire if the block already has a non-paragraph kind", () => {
    // First transform to heading, then type `> ` — should stay heading.
    f.type("# ");
    f.type("> ");
    expect(f.blockKinds()).toEqual(["heading"]);
  });

  it("typing after a shortcut transforms appends text to the new block, not the consumed markdown", () => {
    f.type("# ");
    f.type("Title");
    expect(f.blockTexts()).toEqual(["Title"]);
  });
});

describe("@weaver/dom / markdown shortcuts — inline", () => {
  it("typing `**bold** ` applies a bold mark to 'bold' and removes the `**` delimiters", () => {
    f.type("**bold** ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const boldRun = delta.find((d) => d.attributes?.["bold"]);
    expect(boldRun?.insert).toBe("bold");
    expect(f.blockTexts()[0]).not.toContain("**");
  });

  it("typing `*italic* ` applies an italic mark to 'italic' and removes the `*` delimiters", () => {
    f.type("*italic* ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const italicRun = delta.find((d) => d.attributes?.["italic"]);
    expect(italicRun?.insert).toBe("italic");
    expect(f.blockTexts()[0]).not.toContain("*");
  });

  it("`**bold** ` is never half-consumed by the single-star italic shortcut", () => {
    f.type("mid **bold** ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.find((d) => d.attributes?.["bold"])?.insert).toBe("bold");
    expect(delta.find((d) => d.attributes?.["italic"])).toBeUndefined();
  });

  it("`*italic* ` mid-text marks only the delimited run", () => {
    f.type("keep *just this* ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.find((d) => d.attributes?.["italic"])?.insert).toBe("just this");
    expect(f.blockTexts()[0]).toBe("keep just this ");
  });

  it("typing `_italic_ ` applies an italic mark to 'italic' and removes the `_` delimiters", () => {
    f.type("_italic_ ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const italicRun = delta.find((d) => d.attributes?.["italic"]);
    expect(italicRun?.insert).toBe("italic");
  });

  it("typing `~~strike~~ ` applies a strike mark", () => {
    f.type("~~strike~~ ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const run = delta.find((d) => d.attributes?.["strike"]);
    expect(run?.insert).toBe("strike");
  });

  it("typing `` `code` `` applies an inline code mark", () => {
    f.type("`code` ");
    const id = f.blockEls()[0]!.getAttribute("data-block-id")!;
    const delta = f.editor.commands.text.toDelta(id) as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const run = delta.find((d) => d.attributes?.["code"]);
    expect(run?.insert).toBe("code");
  });
});
