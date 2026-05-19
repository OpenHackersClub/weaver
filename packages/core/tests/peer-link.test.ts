import { describe, expect, it } from "vitest";
import {
  connectPeers,
  createEditor,
  getChildren,
  rootId,
  type Editor,
} from "../src/index.js";
import { future } from "./_test-helpers.js";

/**
 * `connectPeers` tests — the in-process op-forwarding transport behind the
 * Playground's Mock AI agents feature (specs/playground.md § Mock AI agents).
 *
 * The proven two-peer sync pattern lives in concurrency.test.ts /
 * history.test.ts; this suite pins that `connectPeers` automates that
 * export/import handshake without echo loops and without breaking per-peer
 * undo.
 */

const firstBlock = (e: Editor) => getChildren(e, rootId(e))[0]!;

describe("@weaver/core / peer-link — replication", () => {
  it("a local edit on editor A replicates to B and C", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent-1", seed: false });
    const c = createEditor({ origin: "agent-2", seed: false });

    const link = connectPeers(a, b, c);

    const aId = firstBlock(a);
    a.commands.text.insert({ blockId: aId, offset: 0, value: "hello" });

    expect(b.commands.text.read(aId)).toBe("hello");
    expect(c.commands.text.read(aId)).toBe("hello");

    link.dispose();
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("edits replicate in both directions between peers", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(a, b);

    const id = firstBlock(a);
    a.commands.text.insert({ blockId: id, offset: 0, value: "abc" });
    b.commands.text.insert({ blockId: id, offset: 3, value: "def" });

    expect(a.commands.text.read(id)).toBe("abcdef");
    expect(b.commands.text.read(id)).toBe("abcdef");

    link.dispose();
    a.dispose();
    b.dispose();
  });

  it("no echo / no infinite loop — each local edit yields a bounded number of batches", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(a, b);

    // Count every batch each doc observes after the link is established.
    let aBatches = 0;
    let bBatches = 0;
    const subA = a.doc.subscribe(() => aBatches++);
    const subB = b.doc.subscribe(() => bBatches++);

    const id = firstBlock(a);
    a.commands.text.insert({ blockId: id, offset: 0, value: "x" });

    // A sees exactly its own local batch; B sees exactly one imported batch.
    // If the link echoed, these would diverge / not terminate.
    expect(aBatches).toBe(1);
    expect(bBatches).toBe(1);

    b.commands.text.insert({ blockId: id, offset: 1, value: "y" });
    expect(aBatches).toBe(2);
    expect(bBatches).toBe(2);

    expect(a.commands.text.read(id)).toBe("xy");
    expect(b.commands.text.read(id)).toBe("xy");

    subA();
    subB();
    link.dispose();
    a.dispose();
    b.dispose();
  });

  it("a peer connected after edits exist receives the backlog", () => {
    const a = createEditor({ origin: "user" });
    const id = firstBlock(a);
    a.commands.text.insert({ blockId: id, offset: 0, value: "backlog" });

    // `b` is created and connected only after `a` already has content.
    const b = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(a, b);

    expect(b.commands.text.read(id)).toBe("backlog");

    // And live edits keep flowing after the late join.
    a.commands.text.insert({ blockId: id, offset: 7, value: "!" });
    expect(b.commands.text.read(id)).toBe("backlog!");

    link.dispose();
    a.dispose();
    b.dispose();
  });

  it("dispose stops further replication", () => {
    const a = createEditor({ origin: "user" });
    const b = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(a, b);

    const id = firstBlock(a);
    a.commands.text.insert({ blockId: id, offset: 0, value: "live" });
    expect(b.commands.text.read(id)).toBe("live");

    link.dispose();
    a.commands.text.insert({ blockId: id, offset: 4, value: "-dead" });
    expect(a.commands.text.read(id)).toBe("live-dead");
    // `b` is frozen at the pre-dispose state.
    expect(b.commands.text.read(id)).toBe("live");

    a.dispose();
    b.dispose();
  });
});

describe("@weaver/core / peer-link — peer-scoped undo (ADR 0001)", () => {
  it("undoing on an agent peer removes only that peer's ops in the synced human doc", () => {
    // Mirrors history.test.ts §peer scoping: each editor owns its own
    // UndoManager; undo is scoped to that doc's peer. Rejecting an agent =
    // that agent peer's UndoManager.undo() (specs/ai-agent.md §5).
    const human = createEditor({ origin: "user" });
    const agent = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(human, agent);

    const blockId = firstBlock(human);
    human.commands.text.insert({ blockId, offset: 0, value: "by-human" });

    // Agent streams its contribution at the end of the human's text.
    agent.commands.text.insert({
      blockId,
      offset: agent.commands.text.length(blockId),
      value: "-by-agent",
    });

    expect(human.commands.text.read(blockId)).toBe("by-human-by-agent");
    expect(agent.commands.text.read(blockId)).toBe("by-human-by-agent");

    // Reject the agent: its OWN UndoManager.undo() removes exactly its ops.
    future(agent).commands.history.undo();

    expect(agent.commands.text.read(blockId)).toBe("by-human");
    // The undo replicates back to the human doc — the agent's contribution
    // is gone, the human's edit untouched.
    expect(human.commands.text.read(blockId)).toBe("by-human");

    link.dispose();
    human.dispose();
    agent.dispose();
  });

  it("a human undo leaves a concurrent agent's edits intact", () => {
    const human = createEditor({ origin: "user" });
    const agent = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(human, agent);

    const blockId = firstBlock(human);
    human.commands.text.insert({ blockId, offset: 0, value: "human." });
    agent.commands.text.insert({
      blockId,
      offset: agent.commands.text.length(blockId),
      value: "agent.",
    });

    future(human).commands.history.undo();

    // The human's "human." is gone; the agent's "agent." survives on both.
    expect(human.commands.text.read(blockId)).toBe("agent.");
    expect(agent.commands.text.read(blockId)).toBe("agent.");

    link.dispose();
    human.dispose();
    agent.dispose();
  });
});

describe("@weaver/core / peer-link — agent-pending mark over the link", () => {
  it("a streamed insert carrying the agent-pending mark replicates", () => {
    const human = createEditor({ origin: "user" });
    const agent = createEditor({ origin: "agent-1", seed: false });
    const link = connectPeers(human, agent);

    const blockId = firstBlock(agent);
    agent.commands.text.insert({ blockId, offset: 0, value: "draft" });
    agent.commands.text.mark.update({
      blockId,
      range: { start: 0, end: 5 },
      mark: "agent-pending",
      value: "agent-1",
    });

    const delta = human.commands.text.toDelta(blockId) as ReadonlyArray<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta).toEqual([
      { insert: "draft", attributes: { "agent-pending": "agent-1" } },
    ]);

    link.dispose();
    human.dispose();
    agent.dispose();
  });
});

describe("@weaver/core / peer-link — degenerate inputs", () => {
  it("connecting fewer than two editors is an inert no-op", () => {
    const a = createEditor({ origin: "user" });
    const link = connectPeers(a);
    expect(() => link.dispose()).not.toThrow();

    const empty = connectPeers();
    expect(() => empty.dispose()).not.toThrow();

    a.dispose();
  });
});
