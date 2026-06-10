import { Effect, Either } from "effect";
import { EphemeralStore, LoroDoc } from "loro-crdt";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FrameKind, decodeFrame, encodeFrame } from "@weaver/sync-core";
import { inMemoryStore, type SnapshotStore } from "../src/persistence.js";
import { startServer, type RunningServer } from "../src/server.js";

let server: RunningServer;
const clients: WebSocket[] = [];
const stores: EphemeralStore[] = [];

beforeEach(async () => {
  server = await startServer({ port: 0 });
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const store of stores.splice(0)) store.destroy();
  await server.close();
});

/**
 * A connected peer that mirrors a real `@weaver/sync` client: one `LoroDoc` +
 * one presence `EphemeralStore`, fed by demuxing every inbound tagged frame,
 * plus local edits/announcements sent back as tagged frames.
 *
 * The `message` pump is attached at *construction* (before `open`), so no frame
 * — including catch-up frames the server pushes the instant we register — is
 * ever missed in the gap between `open` and a later listener attach.
 */
interface Peer {
  readonly ws: WebSocket;
  readonly doc: LoroDoc;
  readonly presence: EphemeralStore;
  /** Resolve once this peer's body text equals `text`. */
  until(text: string): Promise<void>;
  /** Resolve once this peer sees a presence record under `key`. */
  untilPresent(key: string): Promise<void>;
}

function connect(docId: string): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${docId}`);
  ws.binaryType = "arraybuffer";
  clients.push(ws);

  const doc = new LoroDoc();
  const presence = new EphemeralStore(60_000);
  stores.push(presence);
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  const presenceWaiters: Array<{ key: string; resolve: () => void }> = [];

  ws.on("message", (data: ArrayBuffer) => {
    Either.match(decodeFrame(new Uint8Array(data)), {
      onLeft: (e) => {
        throw new Error(`server relayed an undecodable frame: ${e.reason}`);
      },
      onRight: ({ kind, body }) => {
        if (kind === FrameKind.Doc) doc.import(body);
        else presence.apply(body);
      },
    });
    const text = doc.getText("body").toString();
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.text === text) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
    for (let i = presenceWaiters.length - 1; i >= 0; i -= 1) {
      if (presence.get(presenceWaiters[i]!.key) !== undefined) {
        presenceWaiters[i]!.resolve();
        presenceWaiters.splice(i, 1);
      }
    }
  });

  const peer: Peer = {
    ws,
    doc,
    presence,
    until: (text) =>
      new Promise((resolve) => {
        if (doc.getText("body").toString() === text) resolve();
        else waiters.push({ text, resolve });
      }),
    untilPresent: (key) =>
      new Promise((resolve) => {
        if (presence.get(key) !== undefined) resolve();
        else presenceWaiters.push({ key, resolve });
      }),
  };

  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(peer));
    ws.on("error", reject);
  });
}

/** Apply a local edit and put the resulting tagged update frame on the wire. */
function edit(peer: Peer, text: string): void {
  const from = peer.doc.version();
  const body = peer.doc.getText("body");
  body.insert(body.length, text);
  peer.doc.commit();
  peer.ws.send(
    encodeFrame(FrameKind.Doc, peer.doc.export({ mode: "update", from })),
  );
}

/** Publish a presence record and put the tagged frame on the wire. */
function announce(peer: Peer, key: string, label: string): void {
  peer.presence.set(key, { peerId: key, label });
  peer.ws.send(encodeFrame(FrameKind.Presence, peer.presence.encode(key)));
}

const bodyText = (peer: Peer): string => peer.doc.getText("body").toString();

/** An in-memory store whose `load` is delayed, to widen the cold-hydrate window. */
function delayedLoadStore(ms: number): SnapshotStore {
  const inner = inMemoryStore();
  return {
    load: (docId) => inner.load(docId).pipe(Effect.delay(`${ms} millis`)),
    save: inner.save,
  };
}

it("answers GET /health", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", service: "weaver-sync-node" });
});

it("relays a local edit between two ws peers and converges", async () => {
  const a = await connect("demo");
  const b = await connect("demo");

  edit(a, "hello");

  await b.until("hello");
  expect(bodyText(b)).toBe("hello");
});

it("relays presence between peers and to a late joiner via catch-up", async () => {
  const a = await connect("presence");
  const b = await connect("presence");

  announce(a, "user:ada#tab1", "Ada Lovelace");
  await b.untilPresent("user:ada#tab1");
  expect(b.presence.get("user:ada#tab1")).toMatchObject({
    label: "Ada Lovelace",
  });

  // A fresh peer joining now gets the roster from catch-up frames alone —
  // no one re-announces.
  const c = await connect("presence");
  await c.untilPresent("user:ada#tab1");
  expect(c.presence.get("user:ada#tab1")).toMatchObject({
    label: "Ada Lovelace",
  });
});

it("catches up a late joiner with the canonical snapshot", async () => {
  const a = await connect("late");
  const b = await connect("late");

  // Edit, then wait for b — proving the server imported it into the canonical
  // room before the late peer joins.
  edit(a, "early");
  await b.until("early");

  // A fresh peer joining now must be brought current via the catch-up snapshot.
  const c = await connect("late");
  await c.until("early");
  expect(bodyText(c)).toBe("early");
});

it("buffers frames that arrive before a cold room finishes hydrating", async () => {
  // Widen the cold-start window so the room can't be ready when the first frame
  // lands; the frame must be buffered and drained, not dropped.
  await server.close();
  server = await startServer({ port: 0, store: delayedLoadStore(60) });

  const a = await connect("cold");
  edit(a, "buffered"); // sent while the room is still hydrating

  // After the hydrate window, a fresh joiner must see the early edit via the
  // catch-up snapshot — proving the early frame was buffered, not dropped.
  await new Promise((r) => setTimeout(r, 150));
  const b = await connect("cold");
  await b.until("buffered");
  expect(bodyText(b)).toBe("buffered");
});

it("isolates docs — an edit in one room never reaches another", async () => {
  const a = await connect("room-a");
  const b = await connect("room-b");
  // A second peer in room-a confirms the edit was actually relayed somewhere.
  const a2 = await connect("room-a");

  edit(a, "scoped");
  await a2.until("scoped");

  // If room-b were going to receive it, it would have in the same relay batch.
  expect(bodyText(b)).toBe("");
});
