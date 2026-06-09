import { Effect, Schema } from "effect";

/**
 * Client-side persistence for a LoroDoc's snapshot + tail of ops.
 *
 * Why two slots (snapshot + ops):
 * - **snapshot**: the result of `doc.export({ mode: "snapshot" })` — a full
 *   compacted state. Cheap to rehydrate.
 * - **ops**: an append-only log of `doc.export({ mode: "update", from })`
 *   deltas captured since the last snapshot. Lets us flush every commit
 *   without rewriting the whole snapshot on every keystroke.
 *
 * On load, we apply snapshot first, then replay ops on top.
 *
 * Naming: the spec calls this "OPFS" (Origin Private File System) per
 * `specs/architecture.md#6`. The actual default backend used here is
 * IndexedDB — same origin-private guarantees, available everywhere Loro
 * runs, and `idb` is not yet a dependency. Swapping the backend is a
 * one-Layer change once we want OPFS file handles directly.
 */

/** Errors surfaced by an `OpfsStore`. */
export class OpfsStoreError extends Schema.TaggedError<OpfsStoreError>()(
  "OpfsStoreError",
  {
    op: Schema.Literal(
      "loadSnapshot",
      "saveSnapshot",
      "appendOps",
      "loadOps",
      "clear",
    ),
    docId: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface OpfsStore {
  loadSnapshot(
    docId: string,
  ): Effect.Effect<Uint8Array | null, OpfsStoreError>;
  saveSnapshot(
    docId: string,
    bytes: Uint8Array,
  ): Effect.Effect<void, OpfsStoreError>;
  appendOps(
    docId: string,
    opsBytes: Uint8Array,
  ): Effect.Effect<void, OpfsStoreError>;
  loadOps(
    docId: string,
  ): Effect.Effect<ReadonlyArray<Uint8Array>, OpfsStoreError>;
  /** Drop all persisted state for `docId` (used after compacting to snapshot). */
  clear(docId: string): Effect.Effect<void, OpfsStoreError>;
}

/**
 * In-memory `OpfsStore` — production fallback when no browser storage is
 * available (SSR, Node), and the substrate used by tests. Same contract as
 * the IndexedDB-backed default, just non-durable.
 */
export const createInMemoryOpfsStore = (): OpfsStore => {
  const snapshots = new Map<string, Uint8Array>();
  const ops = new Map<string, Uint8Array[]>();

  return {
    loadSnapshot: (docId) =>
      Effect.sync(() => snapshots.get(docId) ?? null),

    saveSnapshot: (docId, bytes) =>
      Effect.sync(() => {
        snapshots.set(docId, bytes);
        // A fresh snapshot supersedes the tail of ops captured before it.
        ops.delete(docId);
      }),

    appendOps: (docId, opsBytes) =>
      Effect.sync(() => {
        const existing = ops.get(docId);
        if (existing) existing.push(opsBytes);
        else ops.set(docId, [opsBytes]);
      }),

    loadOps: (docId) =>
      Effect.sync(() => [...(ops.get(docId) ?? [])]),

    clear: (docId) =>
      Effect.sync(() => {
        snapshots.delete(docId);
        ops.delete(docId);
      }),
  };
};

/**
 * IndexedDB-backed `OpfsStore`. Uses two object stores keyed by `docId`:
 * `snapshots` (one bytes blob per doc) and `ops` (auto-incremented log of
 * bytes blobs). Falls back to in-memory if `indexedDB` is undefined.
 *
 * This is intentionally minimal — no migrations, no compaction policy, no
 * version negotiation. Phase 2b will replace this with real OPFS file
 * handles once the snapshot/op cadence is profiled against real workloads.
 */
export const createIndexedDbOpfsStore = (
  dbName = "weaver-sync",
): OpfsStore => {
  // Detect at construction time so tests under Node degrade cleanly.
  if (typeof indexedDB === "undefined") {
    return createInMemoryOpfsStore();
  }

  const SNAPSHOTS = "snapshots";
  const OPS = "ops";

  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SNAPSHOTS)) {
          db.createObjectStore(SNAPSHOTS);
        }
        if (!db.objectStoreNames.contains(OPS)) {
          db.createObjectStore(OPS, { autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const tx = <T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
  ): Promise<T> =>
    openDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const t = db.transaction(store, mode);
          const s = t.objectStore(store);
          const r = fn(s);
          if (r instanceof Promise) {
            r.then(resolve, reject);
            return;
          }
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        }),
    );

  const failWith =
    (op: OpfsStoreError["op"], docId: string) =>
    (cause: unknown): OpfsStoreError =>
      new OpfsStoreError({ op, docId, cause });

  return {
    loadSnapshot: (docId) =>
      Effect.tryPromise({
        try: () =>
          tx<Uint8Array | undefined>(SNAPSHOTS, "readonly", (s) =>
            s.get(docId),
          ).then((v) => v ?? null),
        catch: failWith("loadSnapshot", docId),
      }),

    saveSnapshot: (docId, bytes) =>
      Effect.tryPromise({
        try: async () => {
          await tx<IDBValidKey>(SNAPSHOTS, "readwrite", (s) =>
            s.put(bytes, docId),
          );
          // Compact: drop replayed ops once they're folded into the snapshot.
          await tx<undefined>(OPS, "readwrite", (s) => {
            const range = IDBKeyRange.bound(`${docId}:`, `${docId}:￿`);
            return s.delete(range) as IDBRequest<undefined>;
          });
        },
        catch: failWith("saveSnapshot", docId),
      }),

    appendOps: (docId, opsBytes) =>
      Effect.tryPromise({
        try: () =>
          tx<IDBValidKey>(OPS, "readwrite", (s) =>
            // Compound key prefix lets `loadOps` range-scan and `saveSnapshot`
            // range-delete without an index. `Date.now()` is only a
            // best-effort ordering hint, NOT a correctness guarantee: a
            // backward clock jump (or two appends in the same millisecond)
            // can sort a later op before an earlier one. That's fine — Loro
            // import is version-ordered and idempotent, so replaying ops in
            // any order converges to the same state. The random suffix only
            // disambiguates same-millisecond keys.
            s.add(opsBytes, `${docId}:${Date.now()}-${Math.random()}`),
          ).then(() => undefined),
        catch: failWith("appendOps", docId),
      }),

    loadOps: (docId) =>
      Effect.tryPromise({
        try: () =>
          new Promise<Uint8Array[]>((resolve, reject) => {
            openDb().then((db) => {
              const t = db.transaction(OPS, "readonly");
              const s = t.objectStore(OPS);
              const range = IDBKeyRange.bound(
                `${docId}:`,
                `${docId}:￿`,
              );
              const out: Uint8Array[] = [];
              const cur = s.openCursor(range);
              cur.onsuccess = () => {
                const c = cur.result;
                if (c) {
                  out.push(c.value as Uint8Array);
                  c.continue();
                } else {
                  resolve(out);
                }
              };
              cur.onerror = () => reject(cur.error);
            }, reject);
          }),
        catch: failWith("loadOps", docId),
      }),

    clear: (docId) =>
      Effect.tryPromise({
        try: async () => {
          await tx<undefined>(SNAPSHOTS, "readwrite", (s) =>
            s.delete(docId) as IDBRequest<undefined>,
          );
          await tx<undefined>(OPS, "readwrite", (s) => {
            const range = IDBKeyRange.bound(`${docId}:`, `${docId}:￿`);
            return s.delete(range) as IDBRequest<undefined>;
          });
        },
        catch: failWith("clear", docId),
      }),
  };
};
