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
      void onConnection(registry, docId, ws);
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
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

/**
 * Per-connection setup — mirrors `WeaverSyncDO.fetch`: register the peer, push
 * the catch-up snapshot, then relay every inbound frame.
 */
async function onConnection(
  registry: RoomRegistry,
  docId: string,
  ws: WebSocket,
): Promise<void> {
  const room = await registry.get(docId);
  const peer = wsPeer(ws);
  room.register(peer);

  const snapshot = room.catchUpSnapshot();
  if (snapshot) peer.send(snapshot);

  ws.on("message", (data: RawData) => void relayFrame(registry, docId, room, peer, data));
  ws.on("close", () => room.unregister(peer.id));
  ws.on("error", () => room.unregister(peer.id));
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
  data: RawData,
): Promise<void> {
  const frame = toBytes(data);
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
