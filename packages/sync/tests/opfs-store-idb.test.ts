// `fake-indexeddb/auto` installs a spec-compliant `indexedDB` on the global
// BEFORE the store module reads `typeof indexedDB` at construction time, so
// `createIndexedDbOpfsStore` takes its real IndexedDB path instead of the
// in-memory fallback. Keep this import first.
import "fake-indexeddb/auto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createIndexedDbOpfsStore } from "../src/index.js";

/**
 * Exercises the IndexedDB-backed `OpfsStore` — the browser default that the
 * in-memory integration tests can't reach under Node. Covers the compound
 * `${docId}:...` key encoding, range-scoped `loadOps`, snapshot compaction,
 * and per-doc isolation.
 */
describe("@weaver/sync / createIndexedDbOpfsStore (fake-indexeddb)", () => {
  const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e);

  it("round-trips snapshot + ops, compacts on saveSnapshot, isolates by docId", async () => {
    const store = createIndexedDbOpfsStore("weaver-sync-test");
    const docId = "idb-doc-1";

    // Cold start: nothing persisted yet.
    expect(await run(store.loadSnapshot(docId))).toBeNull();
    expect(await run(store.loadOps(docId))).toEqual([]);

    // Append two ops. Ordering is best-effort (same-ms keys disambiguate by a
    // random suffix), so assert membership, not index — matching the store's
    // actual contract (Loro import is order-independent).
    await run(store.appendOps(docId, new Uint8Array([1, 2, 3])));
    await run(store.appendOps(docId, new Uint8Array([4, 5, 6])));
    const ops = (await run(store.loadOps(docId))).map((b) => [...b]);
    expect(ops).toHaveLength(2);
    expect(ops).toContainEqual([1, 2, 3]);
    expect(ops).toContainEqual([4, 5, 6]);

    // Saving a snapshot persists it and truncates the folded-in op log.
    await run(store.saveSnapshot(docId, new Uint8Array([9, 9])));
    const snap = await run(store.loadSnapshot(docId));
    expect(snap && [...snap]).toEqual([9, 9]);
    expect(await run(store.loadOps(docId))).toEqual([]);

    // Ops are range-scoped by docId: a second doc's log is independent.
    await run(store.appendOps("idb-doc-2", new Uint8Array([7])));
    await run(store.appendOps(docId, new Uint8Array([8])));
    expect(await run(store.loadOps(docId))).toHaveLength(1);
    expect(await run(store.loadOps("idb-doc-2"))).toHaveLength(1);

    // `clear` drops both slots for a doc without touching the other.
    await run(store.clear(docId));
    expect(await run(store.loadSnapshot(docId))).toBeNull();
    expect(await run(store.loadOps(docId))).toEqual([]);
    expect(await run(store.loadOps("idb-doc-2"))).toHaveLength(1);

    await run(store.clear("idb-doc-2"));
  });
});
