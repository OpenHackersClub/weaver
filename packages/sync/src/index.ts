import { Effect, Either, Schema } from "effect";
import { decodeImportBlobMeta, VersionVector } from "loro-crdt";
import type { LoroDoc, Subscription } from "loro-crdt";
import type { PresenceHub } from "@weaver/core";
import { FrameKind, decodeFrame, encodeFrame } from "@weaver/sync-core";
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
  type ReconnectHandler,
  WsBridgeError,
  createWsBridge,
  defaultConnectRetry,
} from "./ws-bridge.js";

/**
 * `initSync` wires a LoroDoc to durable storage + an optional WebSocket
 * peer (the Durable Object).
 *
 * Pipeline per spec (`specs/architecture.md#6`, `specs/presence.md`):
 *   1. On init: replay snapshot + tail of ops from `OpfsStore` into `doc`.
 *   2. Subscribe to `doc.subscribe(...)`. For every batch born in this tab
 *      (local commits + imports from in-tab peer editors, e.g. mock-agent
 *      peers), export the delta and (a) append it to OPFS untagged, (b) push
 *      it down the WS bridge as a tagged `doc` frame. Wire-applied imports
 *      are excluded — they must not loop back out.
 *   3. For every inbound WS frame, demux on the kind tag: `doc` bodies import
 *      into `doc` (CRDT merge), `presence` bodies apply into the optional
 *      `PresenceHub`.
 *   4. When a `presence` hub is supplied, its locally-originated updates
 *      (set/remove) go out as tagged `presence` frames — never to storage.
 *
 * Out of scope here (Phase 2b):
 *   - Auth handshake (Biscuit token on the WS upgrade)
 *   - Op validation server-side (currently we trust the peer)
 *   - Subdoc partitioning, per-tier presence filtering, snapshot GC to R2
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
  /**
   * Presence hub to sync over the same socket (`specs/presence.md`). Local
   * records go out as `presence` frames; inbound `presence` frames apply
   * here. Ignored when there is no bridge — presence is wire-only state.
   */
  readonly presence?: PresenceHub;
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
      // Forward every edit born in this tab: local commits AND imports from
      // in-tab peer editors wired by `connectPeers` (the Playground's mock
      // agents reach this doc as `by: "import"` — they're distinct CRDT peers,
      // and their ops must ride the wire like anyone else's).
      //
      // Wire-applied ops must NOT loop back out, but events can't attribute
      // them: Loro defers emission when an import lands inside another event
      // callback, so a flag around `doc.import` misses. Attribution is by
      // VERSION instead — the wire handler below advances the
      // `lastExportedVersion` watermark past everything it applies, so by the
      // time an event for those ops fires the delta is empty and the batch is
      // skipped. In-tab peers' counters are never advanced that way, so their
      // ops always export. Storage replay happens before this subscription
      // attaches and is covered by the same watermark.
      if (batch.by === "checkout") return;
      const current = doc.version();
      if (current.compare(lastExportedVersion) === 0) return;

      const delta = doc.export({
        mode: "update",
        from: lastExportedVersion,
      });
      lastExportedVersion = current;
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
            bridge.send(encodeFrame(FrameKind.Doc, delta)).pipe(
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

    // 3. Inbound WS frames → demux on the kind tag. Doc imports advance the
    //    export watermark so the subscriber above never loops them back out;
    //    presence applies never re-fire the hub's local-update listener.
    // 4. Locally-originated presence updates → tagged presence frames.
    let unsubscribeWs: (() => void) | null = null;
    let unsubscribePresence: (() => void) | null = null;
    let unsubscribeReconnect: (() => void) | null = null;
    const presence = options.presence ?? null;
    if (bridge && wsUrl) {
      unsubscribeWs = bridge.onReceive((bytes) => {
        Either.match(decodeFrame(bytes), {
          onLeft: (e) => {
            // eslint-disable-next-line no-console
            console.warn("[weaver/sync] dropped undecodable inbound frame", e);
          },
          onRight: ({ kind, body }) => {
            try {
              if (kind === FrameKind.Doc) {
                // Fold the blob's version range into the export watermark
                // BEFORE importing: Loro may emit the import's events
                // synchronously (inside `doc.import`) or deferred (when the
                // import lands nested in another event callback), so
                // accounting up front is the only timing-proof attribution.
                // Wire-delivered ops are by definition already known to the
                // relay and must not be re-sent or re-persisted; in-tab
                // peers' counters are untouched, so their ops still export.
                const incoming = decodeImportBlobMeta(
                  body,
                  false,
                ).partialEndVersionVector;
                const merged = lastExportedVersion.toJSON();
                for (const [peer, counter] of incoming.toJSON()) {
                  const prev = merged.get(peer) ?? 0;
                  if (counter > prev) merged.set(peer, counter);
                }
                lastExportedVersion = new VersionVector(merged);
                doc.import(body);
              } else {
                presence?.applyRemote(body);
              }
            } catch (e) {
              // Malformed body — log and drop. Op-validation in the DO
              // (Phase 2b) is the real defense; this is just hygiene.
              // eslint-disable-next-line no-console
              console.warn("[weaver/sync] dropped malformed inbound frame", e);
            }
          },
        });
      });

      if (presence) {
        unsubscribePresence = presence.subscribeLocalUpdates((bytes) => {
          track(
            Effect.runPromise(
              bridge.send(encodeFrame(FrameKind.Presence, bytes)).pipe(
                Effect.catchTag("WsBridgeError", (e) =>
                  Effect.logWarning(
                    "presence send failed (heartbeat republishes)",
                    e,
                  ),
                ),
              ),
            ),
          );
        });
      }

      // Push everything we already know (OPFS-rehydrated state, seed commits
      // made before this wiring attached) up to the relay in one full update.
      // Without this, later deltas reference ops the canonical doc never saw
      // and remote peers stall on missing causal deps. Loro dedups on import,
      // so overlap with the server's state is harmless.
      //
      // This is deliberately dumb: it re-exports the *full* history every time,
      // not a version-vector delta. Version-vector delta sync (only the ops the
      // relay is missing) is the Phase 2b handshake; here, on connect AND on
      // every auto-reconnect, we just dump everything and let Loro dedup.
      const pushFullState = (): void => {
        track(
          Effect.runPromise(
            bridge
              .send(encodeFrame(FrameKind.Doc, doc.export({ mode: "update" })))
              .pipe(
                Effect.catchTag("WsBridgeError", (e) =>
                  Effect.logWarning("full state push failed", e),
                ),
              ),
          ),
        );

        // Same for presence: records published before this wiring attached
        // (apps typically `set` their own record on mount, before the socket
        // is up) would otherwise wait out a full heartbeat to become visible.
        if (presence && presence.all().length > 0) {
          track(
            Effect.runPromise(
              bridge
                .send(encodeFrame(FrameKind.Presence, presence.encodeAll()))
                .pipe(
                  Effect.catchTag("WsBridgeError", (e) =>
                    Effect.logWarning("full presence push failed", e),
                  ),
                ),
            ),
          );
        }
      };

      // Re-push on every genuine re-establishment. The bridge auto-reconnects
      // internally, but doc edits made while disconnected never reconcile until
      // we re-dump full state — the connect-time push runs only once otherwise.
      unsubscribeReconnect = bridge.onReconnect(pushFullState);

      yield* bridge.connect(wsUrl);

      // First-connect push.
      pushFullState();
    }

    return {
      flush: flushSnapshot,

      dispose: () =>
        Effect.gen(function* () {
          // Stop the subscription first so no new writes are scheduled while
          // we drain, then await the in-flight ones (each already recovers
          // its own errors, so the combined promise never rejects).
          docSub();
          if (unsubscribePresence) unsubscribePresence();
          if (unsubscribeWs) unsubscribeWs();
          if (unsubscribeReconnect) unsubscribeReconnect();
          yield* Effect.promise(() => Promise.all([...pending]));
          if (bridge) yield* bridge.disconnect();
        }),

      connectionState: () => (bridge ? bridge.state() : null),
    } satisfies SyncHandle;
  });
