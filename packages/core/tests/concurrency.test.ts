import { describe, expect, it } from "vitest";
import {
  createEditor,
  getBlock,
  getChildren,
  rootId,
  type Editor,
} from "../src/index.js";
import { future } from "./_test-helpers.js";

/**
 * CRDT-tricky tests — two peers, each making conflicting or interleaved edits.
 *
 * These exist to give the implementor confidence that the *interesting* part
 * of the architecture — Loro as the single source of truth — holds across
 * the structural ops weaver layers on top. None of them touch the DOM.
 */

const syncBoth = (a: Editor, b: Editor): void => {
  a.doc.import(b.doc.export({ mode: "update" }));
  b.doc.import(a.doc.export({ mode: "update" }));
};

describe("@weaver/core / concurrency — text edits on the same block", () => {
  it("two non-overlapping inserts on the same block both survive", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);

    const aId = getChildren(a, rootId(a))[0]!;
    const bId = getChildren(b, rootId(b))[0]!;
    a.commands.text.insert({ blockId: aId, offset: 0, value: "abc" });
    syncBoth(a, b);
    expect(b.commands.text.read(bId)).toBe("abc");

    // Both peers insert at different offsets without re-syncing in between.
    a.commands.text.insert({ blockId: aId, offset: 0, value: "<" });
    b.commands.text.insert({ blockId: bId, offset: 3, value: ">" });
    syncBoth(a, b);

    expect(a.commands.text.read(aId)).toBe(b.commands.text.read(bId));
    // Either ordering is acceptable as long as both peers agree.
    expect(a.commands.text.read(aId)).toMatch(/^<abc>$/);

    a.dispose();
    b.dispose();
  });

  it("concurrent insert at the same offset converges to the same order on both peers", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);

    const aId = getChildren(a, rootId(a))[0]!;
    const bId = getChildren(b, rootId(b))[0]!;

    a.commands.text.insert({ blockId: aId, offset: 0, value: "A" });
    b.commands.text.insert({ blockId: bId, offset: 0, value: "B" });
    syncBoth(a, b);

    expect(a.commands.text.read(aId)).toBe(b.commands.text.read(bId));
    // Order is determined by Loro's CRDT semantics; we don't assert which
    // peer wins, only that both peers converge.
    a.dispose();
    b.dispose();
  });
});

describe("@weaver/core / concurrency — structural ops", () => {
  it("two peers each inserting a sibling block both end up in the converged tree", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);

    a.commands.block.insert({
      parentId: rootId(a),
      index: 1,
      kind: "heading",
      attrs: { level: 1 },
    });
    b.commands.block.insert({
      parentId: rootId(b),
      index: 1,
      kind: "quote",
      attrs: {},
    });
    syncBoth(a, b);

    const aKids = getChildren(a, rootId(a)).map(
      (id) => getBlock(a, id)?.kind ?? null,
    );
    const bKids = getChildren(b, rootId(b)).map(
      (id) => getBlock(b, id)?.kind ?? null,
    );
    expect(aKids).toEqual(bKids);
    expect(aKids).toContain("heading");
    expect(aKids).toContain("quote");

    a.dispose();
    b.dispose();
  });

  it("transform on one peer while the other peer edits the same block's text", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);
    const aId = getChildren(a, rootId(a))[0]!;
    const bId = getChildren(b, rootId(b))[0]!;

    a.commands.text.insert({ blockId: aId, offset: 0, value: "Title" });
    syncBoth(a, b);

    a.commands.block.transform({
      blockId: aId,
      newKind: "heading",
      attrs: { level: 1 },
    });
    b.commands.text.insert({
      blockId: bId,
      offset: 5,
      value: "!",
    });
    syncBoth(a, b);

    expect(getBlock(a, aId)?.kind).toBe("heading");
    expect(getBlock(b, bId)?.kind).toBe("heading");
    expect(a.commands.text.read(aId)).toBe("Title!");
    expect(b.commands.text.read(bId)).toBe("Title!");

    a.dispose();
    b.dispose();
  });

  it("delete on one peer while the other inserts a child of that block — child survives or is GC'd consistently", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent", seed: false });
    syncBoth(a, b);

    const aId = getChildren(a, rootId(a))[0]!;
    syncBoth(a, b);
    const bId = getChildren(b, rootId(b))[0]!;
    // Peer a deletes; peer b adds a child to the same block.
    a.commands.block.delete({ blockId: aId });
    b.commands.block.insert({
      parentId: bId,
      index: 0,
      kind: "paragraph",
      attrs: {},
    });
    syncBoth(a, b);

    // Both peers must converge — but we don't pin which policy Loro picks
    // (remove-wins vs add-wins). Verify the JSON shapes match.
    expect(JSON.stringify(a.doc.toJSON())).toBe(JSON.stringify(b.doc.toJSON()));
    a.dispose();
    b.dispose();
  });
});

describe("@weaver/core / concurrency — undo across peers (ADR 0001)", () => {
  it("user undo does not roll back agent edits to the same block", () => {
    const u = createEditor({ origin: "user" });
    const g = createEditor({ origin: "agent", seed: false });
    syncBoth(u, g);

    const uId = getChildren(u, rootId(u))[0]!;
    u.commands.text.insert({ blockId: uId, offset: 0, value: "user." });
    syncBoth(u, g);
    const gId = getChildren(g, rootId(g))[0]!;
    g.commands.text.insert({
      blockId: gId,
      offset: u.commands.text.length(uId),
      value: "agent.",
    });
    syncBoth(u, g);

    future(u).commands.history.undo();
    syncBoth(u, g);

    expect(u.commands.text.read(uId)).toBe("agent.");
    expect(g.commands.text.read(gId)).toBe("agent.");

    u.dispose();
    g.dispose();
  });
});
