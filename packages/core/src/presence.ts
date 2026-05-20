import { EphemeralStore } from "loro-crdt";

/**
 * A single peer's presence — agent or human — as surfaced in the Playground
 * peer panel (see `specs/playground.md` § Mock AI agents, `specs/ai-agent.md`
 * §2.2).
 */
export interface PresenceRecord {
  /** Stable peer identity, e.g. `"agent-1"`. */
  readonly peerId: string;
  /** Human-readable label, e.g. `"Agent 1"`. */
  readonly label: string;
  /** CSS color used to render this peer's cursor / chip. */
  readonly color: string;
  /** Whether the peer is actively streaming edits or idle. */
  readonly mode: "generating" | "idle";
  /** The peer's caret, or `null` when it has no cursor placed. */
  readonly cursor: {
    readonly blockId: string;
    readonly offset: number;
  } | null;
}

/**
 * Shared in-tab presence hub.
 *
 * Backed by ONE Loro `EphemeralStore` instance. In production every peer
 * holds its own store and forwards encoded updates over the wire; for the
 * in-tab Playground demo a single shared store IS the transport — there is
 * no encode/apply step (the "demo simplification" of `specs/playground.md`).
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
  /** Tear down the underlying store. */
  dispose(): void;
}

/**
 * `EphemeralStore` expires keys after an inactivity timeout. A demo session
 * is interactive and long-lived, so we pass a very large timeout — presence
 * records must not vanish mid-demo while an agent sits idle.
 */
const PRESENCE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export const createPresenceHub = (): PresenceHub => {
  // The default `EphemeralStore` value type (`Record<string, Value>`) is the
  // right runtime contract — Loro stores presence records as plain JSON. The
  // typed `PresenceRecord` shape (with `readonly` fields and a nested object)
  // is narrower than Loro's structural `Value`, so we cast at the set/get
  // boundary rather than parameterising the store.
  const store = new EphemeralStore(PRESENCE_TIMEOUT_MS);

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

    dispose: () => {
      store.destroy();
    },
  };
};
