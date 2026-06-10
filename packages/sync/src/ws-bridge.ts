import { Effect, Schema, Schedule } from "effect";

/**
 * Minimal WebSocket transport for the Loro sync protocol.
 *
 * Wire format (Phase 2a): the body of every frame is a raw Loro update
 * blob (`doc.export({ mode: "update", from })`). No framing, no auth,
 * no subdoc routing yet — that lands with the Durable Object in Phase 2b
 * along with Biscuit-token-bearing CONNECT frames (see
 * `specs/access-control.md`).
 *
 * Reconnect: exponential backoff with jitter, capped at 30 s. Mirrors
 * what y-websocket / loro-ws do — nothing exotic.
 */

export class WsBridgeError extends Schema.TaggedError<WsBridgeError>()(
  "WsBridgeError",
  {
    op: Schema.Literal("connect", "send", "close"),
    cause: Schema.Unknown,
  },
) {}

export type ConnectionState =
  | { readonly _kind: "Disconnected" }
  | { readonly _kind: "Connecting" }
  | { readonly _kind: "Connected" }
  | { readonly _kind: "Reconnecting"; readonly attempt: number };

export type ReceiveHandler = (bytes: Uint8Array) => void;

export type ReconnectHandler = () => void;

export interface WsBridge {
  connect(url: string): Effect.Effect<void, WsBridgeError>;
  send(opsBytes: Uint8Array): Effect.Effect<void, WsBridgeError>;
  onReceive(handler: ReceiveHandler): () => void;
  /**
   * Fires on a *genuine re-establishment* of a connection that previously
   * reached OPEN — i.e. an auto-reconnect, not the first connect. Callers use
   * it to re-push connect-time full state (the doc + presence the relay lost
   * track of while we were gone). Returns an unsubscribe fn.
   */
  onReconnect(handler: ReconnectHandler): () => void;
  disconnect(): Effect.Effect<void>;
  state(): ConnectionState;
}

/**
 * Factory for the WebSocket implementation. Defaults to the global
 * `WebSocket`; tests inject a stub.
 */
export interface WsBridgeOptions {
  readonly webSocketFactory?: (url: string) => WebSocket;
  /** Backoff cap. Default 30s. */
  readonly maxBackoffMs?: number;
  /** Disable auto-reconnect (useful for tests + the in-process peer-link demo). */
  readonly autoReconnect?: boolean;
}

const defaultWebSocketFactory = (url: string): WebSocket => {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "WebSocket is not available in this environment; pass `webSocketFactory`",
    );
  }
  return new WebSocket(url);
};

export const createWsBridge = (options: WsBridgeOptions = {}): WsBridge => {
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const autoReconnect = options.autoReconnect ?? true;

  let socket: WebSocket | null = null;
  let url: string | null = null;
  let state: ConnectionState = { _kind: "Disconnected" };
  let attempt = 0;
  let intentionalClose = false;
  // Sticky once we've reached OPEN. Gates auto-reconnect: a *failed initial
  // connect* is owned by the caller's retry policy (`defaultConnectRetry`),
  // which races with `scheduleReconnect` and double-dials. Only auto-reconnect
  // drops of a connection that actually established.
  let everConnected = false;
  const handlers = new Set<ReceiveHandler>();
  const reconnectHandlers = new Set<ReconnectHandler>();

  const scheduleReconnect = () => {
    if (!autoReconnect || !url || intentionalClose) return;
    attempt += 1;
    state = { _kind: "Reconnecting", attempt };
    const wait = Math.min(maxBackoffMs, 2 ** attempt * 100);
    const jitter = wait * (0.5 + Math.random() * 0.5);
    setTimeout(() => {
      // Re-attempt; we deliberately drop errors here — they re-enter the
      // same retry loop via `socket.onerror`.
      void Effect.runPromise(connect(url!)).catch(() => {});
    }, jitter);
  };

  const connect = (target: string): Effect.Effect<void, WsBridgeError> =>
    Effect.async<void, WsBridgeError>((resume) => {
      url = target;
      intentionalClose = false;
      state = { _kind: "Connecting" };
      try {
        const ws = factory(target);
        ws.binaryType = "arraybuffer";
        socket = ws;

        ws.onopen = () => {
          attempt = 0;
          // A re-OPEN of a socket that already reached OPEN once is a genuine
          // re-establishment — notify reconnect handlers so the caller can
          // re-push connect-time full state.
          const isReconnect = everConnected;
          everConnected = true;
          state = { _kind: "Connected" };
          resume(Effect.void);
          if (isReconnect) {
            for (const h of reconnectHandlers) h();
          }
        };

        ws.onmessage = (event) => {
          // Frames are raw Loro update blobs. Coerce whatever the runtime
          // hands us (ArrayBuffer in browsers, Buffer in `ws`/Node) into
          // Uint8Array so handlers don't have to branch.
          const data = event.data;
          let bytes: Uint8Array;
          if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
          } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            );
          } else if (typeof data === "string") {
            bytes = new TextEncoder().encode(data);
          } else {
            // Skip frames we can't interpret rather than crashing the loop.
            return;
          }
          for (const h of handlers) h(bytes);
        };

        ws.onerror = (err) => {
          // The browser doesn't expose error detail; `ws` (Node) does.
          if (state._kind === "Connecting") {
            resume(
              Effect.fail(
                new WsBridgeError({ op: "connect", cause: err }),
              ),
            );
          }
        };

        ws.onclose = () => {
          socket = null;
          if (intentionalClose) {
            state = { _kind: "Disconnected" };
            return;
          }
          // A close before we ever opened means the *initial* connect failed
          // — `onerror` already rejected the connect Effect, so the caller's
          // retry owns re-dialing. Scheduling here too would double-dial.
          if (!everConnected) {
            state = { _kind: "Disconnected" };
            return;
          }
          scheduleReconnect();
        };
      } catch (cause) {
        resume(Effect.fail(new WsBridgeError({ op: "connect", cause })));
      }
    });

  return {
    connect,

    send: (opsBytes) =>
      Effect.try({
        try: () => {
          if (!socket || socket.readyState !== 1 /* OPEN */) {
            throw new Error(
              `ws not open (state=${socket?.readyState ?? "null"})`,
            );
          }
          socket.send(opsBytes);
        },
        catch: (cause) => new WsBridgeError({ op: "send", cause }),
      }),

    onReceive: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    onReconnect: (handler) => {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },

    disconnect: () =>
      Effect.sync(() => {
        intentionalClose = true;
        if (socket) {
          try {
            socket.close();
          } catch {
            // best-effort
          }
        }
        socket = null;
        state = { _kind: "Disconnected" };
        handlers.clear();
        reconnectHandlers.clear();
      }),

    state: () => state,
  };
};

/**
 * Retry schedule used for the initial `connect`. Kept as a separate
 * export so callers (or tests) can compose it: `connect(url).pipe(Effect.retry(...))`.
 */
export const defaultConnectRetry = Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(5)),
);
