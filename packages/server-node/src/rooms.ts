import { Effect, Either } from "effect";
import { SNAPSHOT_EVERY_N_FRAMES, SyncRoom } from "@weaver/sync-core";
import type { SnapshotStore } from "./persistence.js";

/**
 * Holds the canonical `SyncRoom` for each doc in process memory — the Node
 * analogue of "one Durable Object per docId". A single process is the
 * authoritative replica for every room it serves; horizontal scale needs
 * docId-sticky routing or a shared backend (a follow-up, see README).
 */
export class RoomRegistry {
  /**
   * Keyed by docId. We cache the in-flight *promise*, not the resolved room, so
   * two concurrent first-connects to the same doc share one build instead of
   * racing to create two `SyncRoom`s (which would split peers across rival
   * canonical docs that never reconcile). The Cloudflare DO can't hit this —
   * the runtime guarantees one instance per `idFromName(docId)`.
   */
  private readonly rooms = new Map<string, Promise<SyncRoom>>();
  /** docIds with a snapshot write in flight — prevents concurrent double-persist. */
  private readonly persisting = new Set<string>();

  constructor(private readonly store: SnapshotStore) {}

  /** Lazily build (or return the warm) room for a doc. Concurrency-safe. */
  get(docId: string): Promise<SyncRoom> {
    let room = this.rooms.get(docId);
    if (!room) {
      room = this.build(docId);
      this.rooms.set(docId, room);
    }
    return room;
  }

  /**
   * Build a room, rehydrating from the store on first touch. Mirrors
   * `WeaverSyncDO.getRoom`, minus the hibernation peer-reconciliation the Node
   * server doesn't need (its peer set never leaves memory).
   */
  private async build(docId: string): Promise<SyncRoom> {
    const room = new SyncRoom();
    const snapshot = await Effect.runPromise(
      this.store.load(docId).pipe(
        Effect.catchAll((error) => {
          console.warn("[weaver/server-node] snapshot load failed", error);
          return Effect.succeed(null);
        }),
      ),
    );
    if (snapshot) {
      const result = await Effect.runPromise(room.hydrate(snapshot).pipe(Effect.either));
      Either.match(result, {
        onLeft: (error) =>
          console.warn("[weaver/server-node] corrupt snapshot, starting fresh", error),
        onRight: () => undefined,
      });
    }
    return room;
  }

  /**
   * Persist the canonical snapshot once the cadence threshold is reached, then
   * reset the counter — same trigger as `WeaverSyncDO.webSocketMessage`. The
   * counter only resets on a successful write, so a transient failure retries
   * on the next frame instead of silently waiting another full window. An
   * in-flight guard keeps concurrent frame handlers from exporting/writing the
   * same doc twice at once (which can tear a file-backed snapshot).
   */
  async maybePersist(docId: string, room: SyncRoom): Promise<void> {
    if (room.pendingFrames < SNAPSHOT_EVERY_N_FRAMES) return;
    if (this.persisting.has(docId)) return;
    this.persisting.add(docId);
    try {
      const result = await Effect.runPromise(
        this.store.save(docId, room.exportSnapshot()).pipe(Effect.either),
      );
      Either.match(result, {
        onLeft: (error) =>
          console.warn("[weaver/server-node] snapshot persist failed", error),
        onRight: () => room.markSnapshotPersisted(),
      });
    } finally {
      this.persisting.delete(docId);
    }
  }
}
