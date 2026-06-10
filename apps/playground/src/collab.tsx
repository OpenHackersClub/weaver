import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import {
  createPresenceHub,
  getChildren,
  rootId,
  type Editor,
  type Principal,
} from "@weaver/core";
import {
  createInMemoryOpfsStore,
  initSync,
  type SyncHandle,
} from "@weaver/sync";
import { PresenceFacepile, usePresence } from "@weaver/react";
import { PresenceLayer } from "./agents/presence-layer.js";

/**
 * Live-collab session (`specs/presence.md` §Playground demo): wires the
 * visitor's editor + a short-timeout presence hub to a sync relay over one
 * WebSocket. Renders the who's-here facepile and a presence caret layer for
 * any remote record that carries a cursor.
 *
 * Identity (`self`) is app-supplied — here, a demo principal picked by the
 * `?me=` param — exactly the mechanism/identity split the spec prescribes.
 * Persistence is in-memory on purpose: in collab mode the relay's canonical
 * doc is the durable copy, and the local-first OPFS path stays the
 * single-user story.
 */

/** Wire-mode eviction window; pairs with the `usePresence` 15 s heartbeat. */
const WIRE_PRESENCE_TIMEOUT_MS = 45_000;

export const CollabSession = ({
  editor,
  wsUrl,
  docId,
  self,
}: {
  editor: Editor;
  wsUrl: string;
  docId: string;
  self: Principal;
}) => {
  const [hub] = useState(() =>
    createPresenceHub({ timeoutMs: WIRE_PRESENCE_TIMEOUT_MS }),
  );
  const [state, setState] = useState<"connecting" | "live" | "error">(
    "connecting",
  );
  // Called for its publish/heartbeat side effect (publishes `self` into the hub
  // and re-`set`s on an interval); the returned roster is rendered by the
  // facepile from the hub directly, so the value here is intentionally unused.
  usePresence(hub, { self });

  // The sync handle's teardown (`handle.dispose()`) is async and internally
  // unsubscribes from the hub's EphemeralStore. The hub-dispose effect below
  // must await that in-flight teardown before destroying the WASM store —
  // disposing the hub first would free the store out from under the pending
  // unsubscribe (use-after-free / unhandled rejection on unmount).
  const disposingRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let handle: SyncHandle | null = null;
    let cancelled = false;
    // The relay routes rooms by path: /ws/:docId (@weaver/server-node and the
    // DO Worker share the shape). `?ws=` carries just the origin.
    const target = `${wsUrl.replace(/\/+$/, "")}/ws/${encodeURIComponent(docId)}`;
    void Effect.runPromise(
      initSync(editor.doc, {
        docId,
        wsUrl: target,
        store: createInMemoryOpfsStore(),
        presence: hub,
      }),
    )
      .then((h) => {
        if (cancelled) {
          disposingRef.current = Effect.runPromise(h.dispose());
          return;
        }
        handle = h;
        setState("live");
      })
      .catch((error: unknown) => {
        console.error("[playground/collab] connect failed", error);
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      // Record the in-flight teardown so hub disposal can await it. A
      // wsUrl/docId change re-runs this effect (new sync wiring) but must NOT
      // destroy the hub — that only happens on real unmount, below.
      if (handle) disposingRef.current = Effect.runPromise(handle.dispose());
    };
  }, [editor, hub, wsUrl, docId]);

  // Real-unmount only (empty deps): await any in-flight sync teardown, THEN
  // destroy the hub's WASM store. Ordering matters — see disposingRef above.
  useEffect(
    () => () => {
      void disposingRef.current
        .then(() => hub.dispose())
        .catch((error: unknown) => {
          console.warn("[playground/collab] dispose failed", error);
          hub.dispose();
        });
    },
    [hub],
  );

  // A genuinely fresh room has no blocks anywhere (the collab editor mounts
  // with `seed: false`). Give the catch-up snapshot a beat to land, then seed
  // one paragraph so there's something to type into. If two tabs race this,
  // the CRDT merge keeps both paragraphs — cosmetic, not corrupting.
  useEffect(() => {
    if (state !== "live") return;
    const timer = setTimeout(() => {
      if (getChildren(editor, rootId(editor)).length === 0) {
        editor.commands.block.insert({
          parentId: rootId(editor),
          index: 0,
          kind: "paragraph",
          attrs: {},
        });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [state, editor]);

  return (
    <>
      <div className="collab-bar" data-collab-state={state}>
        <span className="collab-doc" title={wsUrl}>
          {state === "error" ? "⚠ relay unreachable" : `doc: ${docId}`}
        </span>
        <PresenceFacepile hub={hub} />
      </div>
      <PresenceLayer editor={editor} presence={hub} />
    </>
  );
};
