import { Effect, Schema } from "effect";
import { LoroDoc } from "loro-crdt";

/**
 * Transport-agnostic relay logic for a single document.
 *
 * A `SyncRoom` owns the *canonical* `LoroDoc` for one doc id and a set of
 * connected peers. It does two things on every inbound frame, mirroring
 * `specs/architecture.md#6` ("DO per doc: canonical LoroDoc in memory, relays
 * validated updates"):
 *
 *   1. **Import** the update into the canonical doc (CRDT merge). The canonical
 *      doc only exists so a late joiner can be caught up with a single
 *      `export({ mode: "snapshot" })`, and so op-validation (Phase 2b) has a
 *      replica to validate against.
 *   2. **Relay** the *raw* frame bytes to every other peer — no decode on the
 *      hot path, matching the spec's relay fast path. The wire format is the
 *      same one `@weaver/sync`'s `WsBridge` speaks: the body of each frame is a
 *      raw Loro update blob (`doc.export({ mode: "update", from })`).
 *
 * Echo suppression is by connection identity: a frame is never relayed back to
 * the peer it came from. This is the wire equivalent of the `batch.by !==
 * "local"` guard in `@weaver/core`'s in-process `connectPeers` and the same
 * guard `@weaver/sync` applies to inbound frames.
 *
 * The room is deliberately transport-free so it can be unit-tested with
 * in-memory fake connections under plain `vitest` (Node), exactly the way
 * `@weaver/sync` tests its `WsBridge` with an injected socket factory. Each
 * deployment target is a thin adapter that maps its runtime's socket to a
 * `PeerConnection`: `@weaver/server` wires Cloudflare's hibernatable WebSocket
 * API, and `@weaver/server-node` wires the Node `ws` library.
 *
 * NOT here (Phase 2b follow-ups, same deferral as PR #19):
 *   - Biscuit-token auth on the WS upgrade and the per-doc read/write gate.
 *   - Server-side op validation (a Loro WASM verifier) — today we trust peers.
 *   - Subdoc partitioning / per-tier filtered broadcast.
 *   - R2 cold snapshots with GC; presence relay over the wire.
 */

/**
 * Re-snapshot the canonical doc to durable storage every N relayed frames, so
 * the in-memory replica can be rebuilt cheaply after an eviction/restart. Same
 * order of magnitude as `@weaver/sync`'s client-side `snapshotEveryNOps` (50) —
 * not yet tuned against real workloads. Shared by every adapter (the Cloudflare
 * Durable Object and the portable Node `ws` server) so the cadence is defined
 * once.
 */
export const SNAPSHOT_EVERY_N_FRAMES = 50;

/** A single connected peer, abstracted away from the WebSocket runtime. */
export interface PeerConnection {
  /** Stable id for the lifetime of the connection. Used for echo suppression. */
  readonly id: string;
  /** Deliver a raw frame to this peer. Must not throw on a closing socket. */
  send(frame: Uint8Array): void;
}

/**
 * An inbound frame could not be merged into the canonical doc — malformed or
 * truncated bytes. We drop it (the relay does not happen) and let the caller
 * log it. Real defense against hostile frames is op-validation in the DO
 * (Phase 2b); this tagged error is the client-hygiene equivalent of the
 * `console.warn` drop in `@weaver/sync`'s inbound handler.
 */
export class FrameImportError extends Schema.TaggedError<FrameImportError>()(
  "FrameImportError",
  {
    connectionId: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class SyncRoom {
  private readonly doc: LoroDoc;
  private readonly peers = new Map<string, PeerConnection>();
  /** Whether the canonical doc holds any committed state worth catching up to. */
  private hasContent = false;
  /** Frames merged since the last persisted snapshot; drives snapshot cadence. */
  private framesSinceSnapshot = 0;

  constructor(doc?: LoroDoc) {
    this.doc = doc ?? new LoroDoc();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** Frames merged since the last `markSnapshotPersisted()`. */
  get pendingFrames(): number {
    return this.framesSinceSnapshot;
  }

  /**
   * Rehydrate the canonical doc from a persisted snapshot (DO storage / R2).
   * Called on a cold start before any peer is served.
   */
  hydrate(snapshot: Uint8Array): Effect.Effect<void, FrameImportError> {
    return Effect.try({
      try: () => this.doc.import(snapshot),
      catch: (cause) => new FrameImportError({ connectionId: "<hydrate>", cause }),
    }).pipe(Effect.tap(() => Effect.sync(() => { this.hasContent = true; })));
  }

  /** Register a peer. Idempotent — re-registering the same id replaces it. */
  register(conn: PeerConnection): void {
    this.peers.set(conn.id, conn);
  }

  /** Drop a peer from the relay set. */
  unregister(connId: string): void {
    this.peers.delete(connId);
  }

  /**
   * The catch-up snapshot a freshly-joined peer needs to converge with the
   * canonical state, or `null` when the doc is still empty (nothing to send).
   */
  catchUpSnapshot(): Uint8Array | null {
    return this.hasContent ? this.doc.export({ mode: "snapshot" }) : null;
  }

  /** Full snapshot for durable persistence. */
  exportSnapshot(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  /** Reset the snapshot cadence counter after a successful persist. */
  markSnapshotPersisted(): void {
    this.framesSinceSnapshot = 0;
  }

  /**
   * Merge an inbound frame into the canonical doc and relay the raw bytes to
   * every *other* peer. Fails with `FrameImportError` (and relays nothing) if
   * the bytes don't decode.
   */
  receiveFrame(
    from: PeerConnection,
    frame: Uint8Array,
  ): Effect.Effect<void, FrameImportError> {
    return Effect.try({
      try: () => this.doc.import(frame),
      catch: (cause) => new FrameImportError({ connectionId: from.id, cause }),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.hasContent = true;
          this.framesSinceSnapshot += 1;
          for (const peer of this.peers.values()) {
            if (peer.id === from.id) continue;
            peer.send(frame);
          }
        }),
      ),
    );
  }
}
