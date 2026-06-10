import { createServer } from "node:http";
import { Effect } from "effect";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { PeerConnection, SyncRoom } from "@weaver/sync-core";
import { wsPeer } from "./peer.js";
import { RoomRegistry } from "./rooms.js";
import { inMemoryStore, type SnapshotStore } from "./persistence.js";

/** `/ws/<docId>` — the doc id may contain slashes (e.g. nested paths). */
const WS_PATH = /^\/ws\/(.+)$/;

export interface ServerOptions {
  /** Listen port. `0` (the default for tests) picks a free ephemeral port. */
  readonly port?: number;
  /** Snapshot persistence. Defaults to an in-memory (ephemeral) store. */
  readonly store?: SnapshotStore;
}

export interface RunningServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Portable Node `ws` adapter for `@weaver/sync-core` — the runtime-neutral
 * relay behind a long-lived WebSocket server, deployable as a container on AWS
 * (or any host). A direct port of `@weaver/server`'s Durable Object: same route
 * shape (`/ws/:docId`, `GET /health`), same per-connection `PeerConnection`
 * mapping, same echo-suppression / catch-up / snapshot-cadence logic. No auth —
 * a bare relay, matching the DO; the Biscuit/ACL gate is the same CF-side Phase
 * 2b work (`specs/access-control.md`).
 */
export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const registry = new RoomRegistry(options.store ?? inMemoryStore());

  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "weaver-sync-node" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = WS_PATH.exec(url.pathname);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const docId = decodeURIComponent(match[1]!);
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(registry, docId, ws);
    });
  });

  return new Promise((resolve) => {
    http.listen(options.port ?? 0, () => {
      const address = http.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            // `wss.close` waits for clients to leave on their own; a browser
            // tab that never says goodbye would hang shutdown forever.
            for (const client of wss.clients) client.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

/**
 * Per-connection setup — mirrors `WeaverSyncDO.fetch`: register the peer, push
 * the catch-up snapshot, then relay every inbound frame.
 *
 * Resolving the room is async (a cold room hydrates from the store), but the
 * socket is already live the instant `handleUpgrade` hands it over. Node's
 * EventEmitter drops `message` events with no listener attached, so we wire the
 * listeners **synchronously** and buffer any frames that arrive during room
 * setup, then drain them in order once the room is ready — otherwise a client
 * that sends immediately on `open` (as `@weaver/sync` does) could have its first
 * edit silently lost. The Cloudflare DO has no such gap; its hibernation API
 * dispatches messages through a single handler.
 */
function onConnection(registry: RoomRegistry, docId: string, ws: WebSocket): void {
  const peer = wsPeer(ws);
  let room: SyncRoom | null = null;
  let closed = false;
  const buffered: Uint8Array[] = [];

  ws.on("message", (data: RawData) => {
    const frame = toBytes(data);
    if (room) void relayFrame(registry, docId, room, peer, frame);
    else buffered.push(frame);
  });
  ws.on("close", () => {
    closed = true;
    if (room) room.unregister(peer.id);
  });
  ws.on("error", () => {
    closed = true;
    if (room) room.unregister(peer.id);
  });

  void (async () => {
    const resolved = await registry.get(docId);
    // The socket may have closed while the room was still hydrating; never
    // register a dead peer (it would leak in the relay set forever).
    if (closed) return;
    room = resolved;
    room.register(peer);

    // Tagged doc snapshot + current presence roster (specs/presence.md).
    for (const frame of room.catchUpFrames()) peer.send(frame);

    // Drain frames received during setup, in arrival order.
    for (const frame of buffered.splice(0)) {
      void relayFrame(registry, docId, room, peer, frame);
    }
  })();
}

/**
 * Import an inbound frame into the canonical doc and relay it, then persist on
 * cadence. Malformed frames are dropped (logged, not relayed, socket stays
 * open) — identical to `WeaverSyncDO.webSocketMessage`.
 */
async function relayFrame(
  registry: RoomRegistry,
  docId: string,
  room: SyncRoom,
  peer: PeerConnection,
  frame: Uint8Array,
): Promise<void> {
  const merged = await Effect.runPromise(
    room.receiveFrame(peer, frame).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn("[weaver/server-node] dropped malformed frame", error);
          return false;
        }),
      ),
    ),
  );
  if (merged) await registry.maybePersist(docId, room);
}

/** Coerce `ws`'s `RawData` (Buffer | ArrayBuffer | Buffer[]) to a `Uint8Array` view. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
