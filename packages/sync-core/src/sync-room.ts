import { Effect, Either, Match, Schema } from "effect";
import { EphemeralStore, LoroDoc } from "loro-crdt";
import {
  type DecodedFrame,
  FrameDecodeError,
  FrameKind,
  decodeFrame,
  encodeFrame,
} from "./frame.js";

/**
 * Transport-agnostic relay logic for a single document.
 *
 * A `SyncRoom` owns the *canonical* `LoroDoc` for one doc id and a set of
 * connected peers. Every inbound frame carries a 1-byte kind tag (`frame.ts`,
 * `specs/presence.md` §Wire protocol) and is handled per kind, mirroring
 * `specs/architecture.md#6` ("DO per doc: canonical LoroDoc in memory, relays
 * validated updates"):
 *
 *   - **doc** — import the update into the canonical doc (CRDT merge), then
 *     relay the raw frame bytes to every other peer. The canonical doc only
 *     exists so a late joiner can be caught up with a single
 *     `export({ mode: "snapshot" })`, and so op-validation (Phase 2b) has a
 *     replica to validate against.
 *   - **presence** — apply into the room's `EphemeralStore` replica (which both
 *     validates the bytes and lets a late joiner get the current roster in one
 *     `encodeAll()`), then relay. Presence is never persisted and never counts
 *     toward the snapshot cadence.
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
 *   - Subdoc partitioning / per-tier filtered broadcast (incl. per-tier
 *     presence filtering — the frame tag reserves the hook point).
 *   - R2 cold snapshots with GC.
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

/**
 * Inactivity timeout for the room's presence replica. Matches the client-side
 * wire default (`specs/presence.md` §Liveness): a peer's record survives as
 * long as its ~15 s heartbeat keeps arriving, and a crashed peer's ghost is
 * evicted within this window.
 */
export const PRESENCE_REPLICA_TIMEOUT_MS = 45_000;

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
  /**
   * Presence replica — exists solely so a late joiner gets the current roster
   * in one `encodeAll()` frame instead of waiting out every peer's next
   * heartbeat, and so inbound presence bytes are validated before relay.
   * Memory-only by design: ephemeral state is never persisted.
   */
  private readonly presence: EphemeralStore;
  private readonly peers = new Map<string, PeerConnection>();
  /** Whether the canonical doc holds any committed state worth catching up to. */
  private hasContent = false;
  /** Doc frames merged since the last persisted snapshot; drives snapshot cadence. */
  private framesSinceSnapshot = 0;

  constructor(doc?: LoroDoc, options?: { presenceTimeoutMs?: number }) {
    this.doc = doc ?? new LoroDoc();
    this.presence = new EphemeralStore(
      options?.presenceTimeoutMs ?? PRESENCE_REPLICA_TIMEOUT_MS,
    );
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
   * The tagged wire frames a freshly-joined peer needs to converge: the doc
   * snapshot (when the doc has content) followed by the current presence
   * roster (when anyone is present). Empty array when there is nothing to send.
   */
  catchUpFrames(): ReadonlyArray<Uint8Array> {
    const frames: Uint8Array[] = [];
    if (this.hasContent) {
      frames.push(
        encodeFrame(FrameKind.Doc, this.doc.export({ mode: "snapshot" })),
      );
    }
    if (this.presence.keys().length > 0) {
      frames.push(encodeFrame(FrameKind.Presence, this.presence.encodeAll()));
    }
    return frames;
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
   * Handle one inbound tagged frame: merge/apply its body per kind, then relay
   * the raw frame bytes to every *other* peer. Fails (and relays nothing) when
   * the tag is unknown (`FrameDecodeError`) or the body doesn't decode
   * (`FrameImportError`).
   */
  receiveFrame(
    from: PeerConnection,
    frame: Uint8Array,
  ): Effect.Effect<void, FrameImportError | FrameDecodeError> {
    return Either.match(decodeFrame(frame), {
      onLeft: (error) => Effect.fail(error),
      onRight: (decoded) =>
        this.absorb(from, decoded).pipe(
          Effect.tap(() => Effect.sync(() => this.relay(from, frame))),
        ),
    });
  }

  /** Merge a decoded frame body into the room's replica for its kind. */
  private absorb(
    from: PeerConnection,
    decoded: DecodedFrame,
  ): Effect.Effect<void, FrameImportError> {
    return Match.value(decoded.kind).pipe(
      Match.when(FrameKind.Doc, () =>
        Effect.try({
          try: () => this.doc.import(decoded.body),
          catch: (cause) =>
            new FrameImportError({ connectionId: from.id, cause }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.hasContent = true;
              this.framesSinceSnapshot += 1;
            }),
          ),
        ),
      ),
      Match.when(FrameKind.Presence, () =>
        Effect.try({
          try: () => this.presence.apply(decoded.body),
          catch: (cause) =>
            new FrameImportError({ connectionId: from.id, cause }),
        }),
      ),
      Match.exhaustive,
    );
  }

  private relay(from: PeerConnection, frame: Uint8Array): void {
    for (const peer of this.peers.values()) {
      if (peer.id === from.id) continue;
      peer.send(frame);
    }
  }

  /** Tear down the presence replica's eviction timer (tests / shutdown). */
  dispose(): void {
    this.presence.destroy();
  }
}
