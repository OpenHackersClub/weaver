/**
 * The bridge's selection-preserving reconcile: a remote/programmatic commit
 * that re-renders a marked block (the `replaceChildren` path) must not drop
 * the user's caret — but a commit that CHANGED the caret block's text must
 * not restore the stale numeric offset either (that would relocate the caret
 * relative to the text the user sees; Loro Cursor anchors are the future
 * fix, specs/hard-problems.md §1).
 */
import { afterEach, describe, expect, it } from "vitest";
import { placeCaret, readDomSelection } from "../src/index.js";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

const flushReconcile = async (): Promise<void> => {
  // doc.subscribe and the bridge's scheduleRerender are both microtasks;
  // a macrotask hop drains them.
  await new Promise((r) => setTimeout(r, 0));
};

describe("@weaver/dom / bridge selection restore across reconciles", () => {
  let fx: DomFixture | null = null;
  afterEach(() => {
    fx?.destroy();
    fx = null;
  });

  it("caret survives a programmatic mark-only commit on its (marked) block", async () => {
    fx = setupDom();
    fx.type("hello world");
    const id = fx.blockEls()[0]!.getAttribute("data-block-id")!;
    // Pre-existing mark forces the non-fast-path (replaceChildren) render.
    fx.editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    fx.bridge.rerender();
    placeCaret(fx.host, { blockId: id, offset: 11 });

    // Text-preserving commit (e.g. an agent highlighting a range).
    fx.editor.commands.text.mark.update({
      blockId: id,
      range: { start: 6, end: 11 },
      mark: "highlight",
      value: true,
    });
    await flushReconcile();

    const sel = readDomSelection(fx.host);
    expect(sel).not.toBeNull();
    expect(sel!.anchor).toEqual({ blockId: id, offset: 11 });
    expect(sel!.collapsed).toBe(true);
  });

  it("does NOT restore a stale offset when the commit changed the block's text", async () => {
    fx = setupDom();
    fx.type("hello");
    const id = fx.blockEls()[0]!.getAttribute("data-block-id")!;
    fx.editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 5 },
      mark: "bold",
    });
    fx.bridge.rerender();
    placeCaret(fx.host, { blockId: id, offset: 5 });

    // Programmatic insert BEFORE the caret — the captured offset 5 now
    // points mid-text; restoring it would relocate the caret.
    fx.editor.commands.text.insert({ blockId: id, offset: 0, value: "XX" });
    await flushReconcile();

    const sel = readDomSelection(fx.host);
    // Either dropped (acceptable) or somewhere — but never the stale
    // numeric offset re-applied onto the changed text.
    if (sel !== null) {
      expect(sel.anchor.offset).not.toBe(5);
    }
  });
});
