import { Effect, Schema } from "effect";
import type { LoroDoc, Subscription } from "loro-crdt";
import {
  createIndexedDbOpfsStore,
  type OpfsStore,
  OpfsStoreError,
} from "./opfs-store.js";
import {
  createWsBridge,
  type WsBridge,
  WsBridgeError,
} from "./ws-bridge.js";

export {
  type OpfsStore,
  OpfsStoreError,
  createInMemoryOpfsStore,
  createIndexedDbOpfsStore,
} from "./opfs-store.js";

export {
  type WsBridge,
  type WsBridgeOptions,
  type ConnectionState,
  type ReceiveHandler,
  WsBridgeError,
  createWsBridge,
  defaultConnectRetry,
} from "./ws-bridge.js";

/**
 * `initSync` wires a LoroDoc to durable storage + an optional WebSocket
 * peer (the Durable Object).
 *
 * Pipeline per spec (`specs/architecture.md#6`):
 *   1. On init: replay snapshot + tail of ops from `OpfsStore` into `doc`.
 *   2. Subscribe to `doc.subscribe(...)`. For every LOCAL batch, export the
 *      delta and (a) append it to OPFS, (b) push it down the WS bridge.
 *   3. For every inbound WS frame, import it into `doc` (CRDT merge).
 *
 * Out of scope here (Phase 2b):
 *   - Real `@weaver/server` DO + auth handshake
 *   - Op validation server-side (currently we trust the peer)
 *   - Subdoc partitioning, presence over WS, snapshot GC to R2
 *
 * The bridge is OPTIONAL — when `wsUrl` is omitted, `initSync` becomes a
 * pure local-first persistence wiring (the v1 single-user MVP from
 * `specs/prd.md#phase-1`).
 */

export interface InitSyncOptions {
  readonly docId: string;
  readonly wsUrl?: string;
  /** Override the storage backend. Defaults to IndexedDB / in-memory fallback. */
  readonly store?: OpfsStore;
  /** Override the transport. Defaults to a real-WebSocket bridge. */
  readonly bridge?: WsBridge;
  /**
   * Re-snapshot cadence. After this many op flushes we re-export the full
   * snapshot and truncate the op log. Default 50 — same order as Loro's
   * own examples; not yet tuned against real workloads.
   */
  readonly snapshotEveryNOps?: number;
}

export interface SyncHandle {
  /** Force a snapshot rewrite + op-log truncation right now. */
  readonly flush: () => Effect.Effect<void, OpfsStoreError>;
  /** Tear down subscriptions and disconnect the WS bridge (if any). */
  readonly dispose: () => Effect.Effect<void>;
  /** Snapshot of the current transport state (or `null` if no bridge). */
  readonly connectionState: () =>
    | ReturnType<WsBridge["state"]>
    | null;
}

/**
 * The errors `initSync` can fail with on the way to a running handle.
 * Imported errors flow through `Effect.catchTag`s in the caller.
 */
export class SyncInitError extends Schema.TaggedError<SyncInitError>()(
  "SyncInitError",
  {
    docId: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export const initSync = (
  doc: LoroDoc,
  options: InitSyncOptions,
): Effect.Effect<SyncHandle, OpfsStoreError | WsBridgeError | SyncInitError> =>
  Effect.gen(function* () {
    const { docId, wsUrl } = options;
    // TODO(ADR 0007): the stores + bridge are injected as plain functions
    // today. ADR 0007 (Effect-TS at the boundaries) commits to Layer-based
    // DI — once `@weaver/server` lands, lift `OpfsStore`/`WsBridge` to
    // `Effect.Tag` services and provide them via `Layer` instead of args.
    const store = options.store ?? createIndexedDbOpfsStore();
    const bridge = options.bridge ?? (wsUrl ? createWsBridge() : null);
    const snapshotEveryNOps = options.snapshotEveryNOps ?? 50;

    // 1. Rehydrate. Snapshot first (cheap), then ops on top.
    // TODO(perf): this re-imports the full snapshot + every stored op on
    // each load — O(n) in the op-log length. Once profiled, skip the
    // re-import when the doc's version vector already dominates the stored
    // state (tracked for a follow-up; harmless today at MVP doc sizes).
    const snapshot = yield* store.loadSnapshot(docId);
    if (snapshot) {
      yield* Effect.try({
        try: () => doc.import(snapshot),
        catch: (cause) => new SyncInitError({ docId, cause }),
      });
    }
    const ops = yield* store.loadOps(docId);
    for (const opBytes of ops) {
      yield* Effect.try({
        try: () => doc.import(opBytes),
        catch: (cause) => new SyncInitError({ docId, cause }),
      });
    }

    // 2. Subscribe to LOCAL commits. Each one becomes:
    //    - an `appendOps` to storage
    //    - a `bridge.send` if the WS is up
    // We export with `from: previousVersion` so the bytes we emit are
    // the minimal delta — matches what `connectPeers` does in core.
    let lastExportedVersion = doc.version();
    let opsSinceSnapshot = 0;

    // Track in-flight fire-and-forget writes so `dispose` can drain them.
    // Without this, a rapid edit→dispose (e.g. on `beforeunload`) drops the
    // trailing ops: the IndexedDB store and real WS send settle async and
    // may not have flushed when the subscription is torn down.
    const pending = new Set<Promise<unknown>>();
    const track = (p: Promise<unknown>): void => {
      pending.add(p);
      void p.finally(() => pending.delete(p));
    };

    const flushSnapshot = (): Effect.Effect<void, OpfsStoreError> =>
      Effect.gen(function* () {
        const bytes = doc.export({ mode: "snapshot" });
        yield* store.saveSnapshot(docId, bytes);
        lastExportedVersion = doc.version();
        opsSinceSnapshot = 0;
      });

    const docSub: Subscription = doc.subscribe((batch) => {
      // Only forward LOCAL edits. Imported ops (from the wire OR replayed
      // from storage) must not loop back out to storage/wire.
      if (batch.by !== "local") return;

      const delta = doc.export({
        mode: "update",
        from: lastExportedVersion,
      });
      lastExportedVersion = doc.version();
      opsSinceSnapshot += 1;

      // Fire-and-forget: persistence + transport are independent. Failures
      // are logged but don't crash the editor — local-first is the default.
      track(
        Effect.runPromise(
          store
            .appendOps(docId, delta)
            .pipe(Effect.catchAll((e) => Effect.logError("opfs append failed", e))),
        ),
      );

      if (bridge) {
        track(
          Effect.runPromise(
            bridge.send(delta).pipe(
              Effect.catchTag("WsBridgeError", (e) =>
                Effect.logWarning("ws send failed (will retry on reconnect)", e),
              ),
            ),
          ),
        );
      }

      if (opsSinceSnapshot >= snapshotEveryNOps) {
        track(
          Effect.runPromise(
            flushSnapshot().pipe(
              Effect.catchAll((e) =>
                Effect.logError("snapshot flush failed", e),
              ),
            ),
          ),
        );
      }
    });

    // 3. Inbound WS frames → import into doc. Imports trigger a non-local
    //    batch, which the subscriber above will correctly ignore.
    let unsubscribeWs: (() => void) | null = null;
    if (bridge && wsUrl) {
      unsubscribeWs = bridge.onReceive((bytes) => {
        try {
          doc.import(bytes);
        } catch (e) {
          // Malformed frame — log and drop. Op-validation in the DO (Phase
          // 2b) is the real defense; this is just hygiene.
          // eslint-disable-next-line no-console
          console.warn("[weaver/sync] dropped malformed inbound frame", e);
        }
      });
      yield* bridge.connect(wsUrl);
    }

    return {
      flush: flushSnapshot,

      dispose: () =>
        Effect.gen(function* () {
          // Stop the subscription first so no new writes are scheduled while
          // we drain, then await the in-flight ones (each already recovers
          // its own errors, so the combined promise never rejects).
          docSub();
          if (unsubscribeWs) unsubscribeWs();
          yield* Effect.promise(() => Promise.all([...pending]));
          if (bridge) yield* bridge.disconnect();
        }),

      connectionState: () => (bridge ? bridge.state() : null),
    } satisfies SyncHandle;
  });
