import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { PeerConnection } from "@weaver/sync-core";

/**
 * Wrap a Node `ws` socket as a transport-agnostic `PeerConnection`. The Node
 * analogue of the Durable Object's `peerFor` (`@weaver/server`): a stable id for
 * echo suppression plus a `send` that swallows errors on a closing socket — the
 * `close`/`error` handlers do the unregister.
 */
export function wsPeer(ws: WebSocket): PeerConnection {
  return {
    id: randomUUID(),
    send: (frame) => {
      try {
        ws.send(frame);
      } catch {
        // Socket is closing/closed; the close handler will unregister it.
      }
    },
  };
}
