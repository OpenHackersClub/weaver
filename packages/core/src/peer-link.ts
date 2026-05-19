import type { Subscription } from "loro-crdt";
import type { Editor } from "./editor.js";

/**
 * In-process op forwarding between 2+ editors.
 *
 * This is the demo transport for the Playground's "Mock AI agents" feature
 * (see `specs/playground.md` § Mock AI agents): each editor owns a distinct
 * `LoroDoc` peer, and `connectPeers` short-circuits the transport so every
 * LOCAL commit replicates into every other peer's `LoroDoc` synchronously,
 * in the same tab. The merge that runs is the ordinary Loro CRDT merge — only
 * the network hop is elided. Production agents connect over a WebSocket to a
 * Durable Object as a separate peer (see `specs/ai-agent.md` §2.1).
 */
export interface PeerLink {
  /** Unsubscribe every editor wired by this link. */
  dispose(): void;
}

/**
 * Wire 2+ editors so each LOCAL commit replicates into every other peer's
 * `LoroDoc` in-process.
 *
 * On connect, every peer is first brought up to the union of all peers'
 * current state (an all-pairs initial sync). After that, each editor's
 * `doc` is subscribed; whenever a batch with `by === "local"` lands, the
 * delta since each other peer's version is exported and imported into that
 * peer.
 *
 * Echo-free: only `"local"` batches are forwarded — never `"import"` or
 * `"checkout"`. An imported op never triggers another forward, which is what
 * prevents an infinite echo loop. Importing already-known ops is a no-op, so
 * `connectPeers` is safe to call repeatedly with overlapping editor sets.
 */
export const connectPeers = (
  ...editors: ReadonlyArray<Editor>
): PeerLink => {
  // A single editor (or none) has nobody to sync with — return an inert link.
  if (editors.length < 2) {
    return { dispose: () => {} };
  }

  // Initial all-pairs sync: import every editor's current state into every
  // other editor. Two passes guarantee convergence to the union — after the
  // first pass each later editor holds everything from earlier editors; the
  // second pass pushes the now-complete state back to the earlier ones.
  for (let pass = 0; pass < 2; pass++) {
    for (const source of editors) {
      const update = source.doc.export({ mode: "update" });
      for (const target of editors) {
        if (target === source) continue;
        target.doc.import(update);
      }
    }
  }

  const subscriptions: Subscription[] = [];

  for (const editor of editors) {
    const sub = editor.doc.subscribe((batch) => {
      // Only forward edits that originated locally on this editor. Imported /
      // checkout batches are the ops we just replicated — re-forwarding them
      // would loop forever.
      if (batch.by !== "local") return;
      for (const other of editors) {
        if (other === editor) continue;
        // Export only the delta the other peer is missing. Importing ops it
        // already has is a harmless no-op.
        const delta = editor.doc.export({
          mode: "update",
          from: other.doc.version(),
        });
        other.doc.import(delta);
      }
    });
    subscriptions.push(sub);
  }

  return {
    dispose: () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      subscriptions.length = 0;
    },
  };
};
