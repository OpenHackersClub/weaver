import { Effect } from "effect";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  createInMemoryOpfsStore,
  initSync,
  type OpfsStore,
  type WsBridge,
  type ReceiveHandler,
} from "../src/index.js";

/**
 * Integration tests for `@weaver/sync`.
 *
 * Strategy: drive a real `LoroDoc`, persist through an in-memory
 * `OpfsStore`, then construct a SECOND `LoroDoc` and rehydrate it from
 * the same store. The second doc should converge on the first's state.
 *
 * The IndexedDB-backed store is exercised in the browser (Playground
 * acceptance tests, follow-up). Node has no `indexedDB`; the in-memory
 * store has the same contract.
 */

const newDoc = (peerId?: bigint): LoroDoc => {
  const doc = new LoroDoc();
  if (peerId !== undefined) doc.setPeerId(peerId);
  return doc;
};

const writeSomeText = (doc: LoroDoc, key: string, value: string) => {
  const text = doc.getText(key);
  text.insert(0, value);
  doc.commit();
};

describe("@weaver/sync / initSync — persistence", () => {
  it("persists local edits and rehydrates them on reload", async () => {
    const store = createInMemoryOpfsStore();
    const docId = "doc-1";

    // First session: write some content and let `initSync` capture it.
    const docA = newDoc(1n);
    const handleA = await Effect.runPromise(
      initSync(docA, { docId, store }),
    );

    writeSomeText(docA, "body", "hello, weaver");
    // Wait a tick so the fire-and-forget `appendOps` lands.
    await new Promise((r) => setTimeout(r, 0));

    await Effect.runPromise(handleA.dispose());

    // Second session: fresh doc, rehydrate from the same store.
    const docB = newDoc(2n);
    const handleB = await Effect.runPromise(
      initSync(docB, { docId, store }),
    );

    expect(docB.getText("body").toString()).toBe("hello, weaver");

    await Effect.runPromise(handleB.dispose());
  });

  it("flushes a snapshot and truncates the op log", async () => {
    const store = createInMemoryOpfsStore();
    const docId = "doc-2";

    const doc = newDoc(1n);
    const handle = await Effect.runPromise(
      initSync(doc, { docId, store }),
    );

    writeSomeText(doc, "body", "abc");
    await new Promise((r) => setTimeout(r, 0));

    // Before the manual flush the op log holds at least one entry.
    const opsBefore = await Effect.runPromise(store.loadOps(docId));
    expect(opsBefore.length).toBeGreaterThan(0);

    await Effect.runPromise(handle.flush());

    // After the flush the snapshot is populated and ops are truncated.
    const snapshot = await Effect.runPromise(store.loadSnapshot(docId));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.byteLength).toBeGreaterThan(0);

    const opsAfter = await Effect.runPromise(store.loadOps(docId));
    expect(opsAfter.length).toBe(0);

    await Effect.runPromise(handle.dispose());
  });

  it("drains in-flight async op writes before dispose resolves", async () => {
    // Wrap the in-memory store so `appendOps` settles on a macrotask — the
    // real IndexedDB / WS write latency the fire-and-forget path has to
    // tolerate. Without draining in `dispose`, the trailing op is lost.
    const inner = createInMemoryOpfsStore();
    const slowStore: OpfsStore = {
      ...inner,
      appendOps: (docId, bytes) =>
        Effect.flatMap(
          Effect.promise(() => new Promise((r) => setTimeout(r, 5))),
          () => inner.appendOps(docId, bytes),
        ),
    };
    const docId = "doc-drain";

    const doc = newDoc(1n);
    const handle = await Effect.runPromise(
      initSync(doc, { docId, store: slowStore }),
    );

    writeSomeText(doc, "body", "trailing edit");
    // Dispose immediately — do NOT wait a tick. The pending `appendOps` is
    // still in flight; `dispose` must await it.
    await Effect.runPromise(handle.dispose());

    const ops = await Effect.runPromise(slowStore.loadOps(docId));
    expect(ops.length).toBeGreaterThan(0);
  });
});

/**
 * A fake `WsBridge` that loops `send` straight back through a paired
 * receiver. Stands in for the real Durable Object until `@weaver/server`
 * lands in Phase 2b.
 */
const createLoopbackBridges = (): [WsBridge, WsBridge] => {
  const handlersA = new Set<ReceiveHandler>();
  const handlersB = new Set<ReceiveHandler>();

  const make = (
    own: Set<ReceiveHandler>,
    peer: Set<ReceiveHandler>,
  ): WsBridge => ({
    connect: () => Effect.void,
    send: (bytes) =>
      Effect.sync(() => {
        for (const h of peer) h(bytes);
      }),
    onReceive: (h) => {
      own.add(h);
      return () => {
        own.delete(h);
      };
    },
    disconnect: () =>
      Effect.sync(() => {
        own.clear();
      }),
    state: () => ({ _kind: "Connected" }) as const,
  });

  return [make(handlersA, handlersB), make(handlersB, handlersA)];
};

describe("@weaver/sync / initSync — transport", () => {
  it("replicates a local edit to a peer via the bridge", async () => {
    const storeA = createInMemoryOpfsStore();
    const storeB = createInMemoryOpfsStore();
    const [bridgeA, bridgeB] = createLoopbackBridges();
    const docId = "doc-3";

    const docA = newDoc(1n);
    const docB = newDoc(2n);

    const handleA = await Effect.runPromise(
      initSync(docA, {
        docId,
        wsUrl: "ws://loopback",
        store: storeA,
        bridge: bridgeA,
      }),
    );
    const handleB = await Effect.runPromise(
      initSync(docB, {
        docId,
        wsUrl: "ws://loopback",
        store: storeB,
        bridge: bridgeB,
      }),
    );

    writeSomeText(docA, "body", "from A");
    await new Promise((r) => setTimeout(r, 0));

    expect(docB.getText("body").toString()).toBe("from A");

    await Effect.runPromise(handleA.dispose());
    await Effect.runPromise(handleB.dispose());
  });
});
