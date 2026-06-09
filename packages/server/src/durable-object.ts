import { DurableObject } from "cloudflare:workers";
import { Effect, Either } from "effect";
import { type PeerConnection, SyncRoom } from "./sync-room.js";

export interface Env {
  /** Per-document relay DO. One instance per `idFromName(docId)`. */
  readonly WEAVER_SYNC: DurableObjectNamespace<WeaverSyncDO>;
}

/** DO storage key holding the latest canonical snapshot. */
const SNAPSHOT_KEY = "snapshot";

/**
 * Re-snapshot the canonical doc to DO storage every N relayed frames, then
 * the in-memory replica can be rebuilt cheaply after hibernation/eviction.
 * Same order of magnitude as `@weaver/sync`'s client-side `snapshotEveryNOps`
 * (50) — not yet tuned against real workloads.
 *
 * NOTE: this MVP persists a full snapshot rather than an appended op-log with
 * truncation (the `specs/architecture.md#6` "deltas to DO storage, snapshots to
 * R2" split). Snapshot-only keeps rehydration a single `import`; the op-log +
 * R2 cold-storage split is a Phase 2b follow-up.
 */
const SNAPSHOT_EVERY_N_FRAMES = 50;

/**
 * Per-document Loro-sync relay, backed by Cloudflare's **hibernatable**
 * WebSocket API. Because the runtime can evict the DO's memory while sockets
 * stay open, all durable state lives in DO storage and the in-memory
 * `SyncRoom` is rebuilt lazily on the next event — reconciling the live peer
 * set from `ctx.getWebSockets()`.
 *
 * The auth/ACL gate is intentionally *not* here — it belongs at the WS upgrade
 * in the Worker (`worker.ts`), where the Biscuit token and D1 ACL lookup land
 * in Phase 2b (`specs/access-control.md` §"WS upgrade flow"). By the time a
 * socket reaches this DO it is assumed authorized.
 */
export class WeaverSyncDO extends DurableObject<Env> {
  /** Warm cache of the room; `null` after a cold start until `getRoom()` builds it. */
  private room: SyncRoom | null = null;

  /**
   * Lazily build (or return the warm) `SyncRoom`, rehydrating the canonical
   * doc from storage and reconciling peers from the live socket set. Safe to
   * call on every event.
   */
  private async getRoom(): Promise<SyncRoom> {
    if (this.room) return this.room;

    const room = new SyncRoom();
    const snapshot = await this.ctx.storage.get<Uint8Array>(SNAPSHOT_KEY);
    if (snapshot) {
      await Effect.runPromise(room.hydrate(snapshot));
    }
    // Re-attach any sockets that survived a hibernation cycle.
    for (const ws of this.ctx.getWebSockets()) {
      const peer = this.peerFor(ws);
      if (peer) room.register(peer);
    }
    this.room = room;
    return room;
  }

  /** Wrap a hibernatable socket as a `PeerConnection`, reading its stable id. */
  private peerFor(ws: WebSocket): PeerConnection | null {
    const attachment = ws.deserializeAttachment() as { id?: string } | null;
    const id = attachment?.id;
    if (!id) return null;
    return {
      id,
      send: (frame) => {
        try {
          ws.send(frame);
        } catch {
          // Socket is closing/closed; the close handler will unregister it.
        }
      },
    };
  }

  /** Handle the WS upgrade forwarded by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Stable per-connection id, stored on the socket so it survives hibernation.
    const id = crypto.randomUUID();
    server.serializeAttachment({ id });

    // Hibernatable accept: the DO can sleep with this socket open.
    this.ctx.acceptWebSocket(server);

    const room = await this.getRoom();
    const peer = this.peerFor(server);
    if (peer) {
      room.register(peer);
      const snapshot = room.catchUpSnapshot();
      if (snapshot) peer.send(snapshot);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    const frame =
      typeof message === "string"
        ? new TextEncoder().encode(message)
        : new Uint8Array(message);

    const room = await this.getRoom();
    const sender = this.peerFor(ws);
    if (!sender) return;

    const result = await Effect.runPromise(
      room.receiveFrame(sender, frame).pipe(Effect.either),
    );
    const merged = Either.match(result, {
      // Malformed frame — dropped (not relayed). Op-validation in Phase 2b is
      // the real defense; this is hygiene. We deliberately do not close the
      // socket on a single bad frame.
      onLeft: (error) => {
        console.warn("[weaver/server] dropped malformed frame", error);
        return false;
      },
      onRight: () => true,
    });
    if (!merged) return;

    if (room.pendingFrames >= SNAPSHOT_EVERY_N_FRAMES) {
      await this.ctx.storage.put(SNAPSHOT_KEY, room.exportSnapshot());
      room.markSnapshotPersisted();
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const peer = this.peerFor(ws);
    if (peer) (await this.getRoom()).unregister(peer.id);
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const peer = this.peerFor(ws);
    if (peer) (await this.getRoom()).unregister(peer.id);
  }
}
