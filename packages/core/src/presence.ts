import { EphemeralStore } from "loro-crdt";
import type { PrincipalKind } from "./principal.js";

/**
 * A single peer's presence — agent or human — as rendered in facepiles and
 * caret overlays (see `specs/presence.md`, `specs/ai-agent.md` §2.2).
 */
export interface PresenceRecord {
  /**
   * The store key. Unique **per session** (per tab), e.g. `"agent-1"` or
   * `"user:ada#k3df9"` — two tabs of the same principal must not clobber each
   * other's record (`specs/presence.md` §State layering).
   */
  readonly peerId: string;
  /**
   * Stable identity behind this session — a `Principal.id`. Facepiles dedupe
   * by this; caret overlays key by `peerId`. Defaults to `peerId` when absent
   * (the in-tab mock agents, whose session is their identity).
   */
  readonly principalId?: string;
  /** Human-readable label, e.g. `"Agent 1"` or `"Ada Lovelace"`. */
  readonly label: string;
  /** CSS color used to render this peer's cursor / chip. */
  readonly color: string;
  /** Mirrors `Principal.kind`; absent on legacy records. */
  readonly kind?: PrincipalKind;
  /** Optional avatar image URL (facepile rendering). */
  readonly avatarUrl?: string;
  /** Whether the peer is actively streaming edits or idle. */
  readonly mode: "generating" | "idle";
  /** The peer's caret, or `null` when it has no cursor placed. */
  readonly cursor: {
    readonly blockId: string;
    readonly offset: number;
  } | null;
}

/**
 * Presence hub: one Loro `EphemeralStore` per editor session.
 *
 * In-tab demo peers (Playground mock agents) share a single hub directly. Over
 * the network every peer holds its own hub and the sync layer forwards encoded
 * updates both ways: `subscribeLocalUpdates` bytes go out on the wire,
 * inbound presence frames come back through `applyRemote`
 * (`specs/presence.md` §Wire protocol; wired by `@weaver/sync`'s `initSync`).
 */
export interface PresenceHub {
  /** Publish (or overwrite) a peer's presence record. */
  set(record: PresenceRecord): void;
  /** Drop a peer's presence record. */
  remove(peerId: string): void;
  /** Every currently-published presence record. */
  all(): ReadonlyArray<PresenceRecord>;
  /** Register a listener fired whenever the set of records changes. */
  subscribe(listener: () => void): () => void;
  /** Merge presence bytes received from the wire into this hub. */
  applyRemote(bytes: Uint8Array): void;
  /**
   * Register a listener for *locally-originated* updates (set/remove), already
   * encoded for the wire. Remote `applyRemote` bytes do not re-fire it, so
   * forwarding these straight to the transport cannot loop.
   */
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  /** Encode every live record — the late-joiner catch-up payload. */
  encodeAll(): Uint8Array;
  /** Tear down the underlying store. */
  dispose(): void;
}

/**
 * Default inactivity timeout, tuned for the *in-tab* demo: a session is
 * interactive and long-lived, and an idle mock agent must not vanish mid-demo,
 * so the default is effectively "never". Networked hubs pass a short
 * `timeoutMs` (~45 s) and pair it with the `usePresence` heartbeat so a
 * crashed peer's ghost is evicted quickly (`specs/presence.md` §Liveness).
 */
const DEFAULT_PRESENCE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export interface PresenceHubOptions {
  /** Inactivity timeout in ms before a record is evicted. Default 24 h. */
  readonly timeoutMs?: number;
}

export const createPresenceHub = (
  options: PresenceHubOptions = {},
): PresenceHub => {
  // The default `EphemeralStore` value type (`Record<string, Value>`) is the
  // right runtime contract — Loro stores presence records as plain JSON. The
  // typed `PresenceRecord` shape (with `readonly` fields and a nested object)
  // is narrower than Loro's structural `Value`, so we cast at the set/get
  // boundary rather than parameterising the store.
  const store = new EphemeralStore(
    options.timeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS,
  );

  return {
    set: (record) => {
      store.set(record.peerId, { ...record });
    },

    remove: (peerId) => {
      store.delete(peerId);
    },

    all: () =>
      Object.values(store.getAllStates()) as unknown as PresenceRecord[],

    subscribe: (listener) => store.subscribe(() => listener()),

    applyRemote: (bytes) => {
      store.apply(bytes);
    },

    subscribeLocalUpdates: (listener) => store.subscribeLocalUpdates(listener),

    encodeAll: () => store.encodeAll(),

    dispose: () => {
      store.destroy();
    },
  };
};
