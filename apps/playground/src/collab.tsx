import { useEffect, useMemo, useRef, useState } from "react";
import { Effect } from "effect";
import {
  getChildren,
  rootId,
  type Editor,
  type PresenceHub,
  type Principal,
} from "@weaver/core";
import {
  createInMemoryOpfsStore,
  initSync,
  type SyncHandle,
} from "@weaver/sync";
import { PresenceFacepile, usePresence, useSelection } from "@weaver/react";
import { PresenceLayer } from "./agents/presence-layer.js";

/**
 * Live-collab session (`specs/presence.md` §Playground demo): wires the
 * visitor's editor + a short-timeout presence hub to a sync relay over one
 * WebSocket. Renders the who's-here facepile and a presence caret layer for
 * any remote record that carries a cursor.
 *
 * The hub is app-owned and SHARED with the mock-agent runtime, so agents and
 * humans publish into one roster — one facepile, one caret overlay, and agent
 * presence rides the wire to remote tabs. This component takes over the hub's
 * teardown (see the dispose-ordering dance below); the runtime never disposes
 * a hub it didn't create.
 *
 * Identity (`self`) is app-supplied — here, a demo principal picked by the
 * `?me=` param — exactly the mechanism/identity split the spec prescribes.
 * Persistence is in-memory on purpose: in collab mode the relay's canonical
 * doc is the durable copy, and the local-first OPFS path stays the
 * single-user story.
 */

/** Wire-mode eviction window; pairs with the `usePresence` 15 s heartbeat. */
export const WIRE_PRESENCE_TIMEOUT_MS = 45_000;

export const CollabSession = ({
  editor,
  hub,
  wsUrl,
  docId,
  self,
  seedIfEmpty,
}: {
  editor: Editor;
  hub: PresenceHub;
  wsUrl: string;
  docId: string;
  self: Principal;
  /** Seeds the currently-selected example; called once on a fresh room. */
  seedIfEmpty: () => void;
}) => {
  const [state, setState] = useState<"connecting" | "live" | "error">(
    "connecting",
  );
  // The local caret rides the presence record so remote peers render this
  // session in their caret overlay too — cursors and the facepile must always
  // draw from the same identity set (`specs/presence.md` §Playground demo).
  const selection = useSelection(editor);
  const cursor = useMemo(
    () =>
      selection === null
        ? null
        : {
            blockId: selection.focus.blockId,
            offset: selection.focus.offset,
          },
    [selection],
  );
  // Publishes `self` (+ live cursor) into the hub and re-`set`s on a
  // heartbeat; the roster itself is rendered by the facepile from the hub
  // directly, so only `selfPeerId` is consumed here.
  const { selfPeerId } = usePresence(hub, { self, cursor });

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
  // the selected example so a default room demos real content. If two tabs
  // race this, the CRDT merge keeps both copies — cosmetic, not corrupting.
  // On relay error no snapshot is coming, so seed immediately: the tab stays
  // usable single-user, and edits merge later if the bridge reconnects.
  useEffect(() => {
    if (state === "connecting") return;
    const timer = setTimeout(
      () => {
        if (getChildren(editor, rootId(editor)).length === 0) seedIfEmpty();
      },
      state === "live" ? 500 : 0,
    );
    return () => clearTimeout(timer);
  }, [state, editor, seedIfEmpty]);

  return (
    <>
      <div className="collab-bar" data-collab-state={state}>
        <span className="collab-doc" title={wsUrl}>
          {state === "error" ? "⚠ relay unreachable" : `doc: ${docId}`}
        </span>
        <PresenceFacepile hub={hub} />
      </div>
      <PresenceLayer editor={editor} presence={hub} excludePeerId={selfPeerId} />
    </>
  );
};
