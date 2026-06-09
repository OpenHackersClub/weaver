import { Effect } from "effect";
import { LoroDoc } from "loro-crdt";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inMemoryStore, type SnapshotStore } from "../src/persistence.js";
import { startServer, type RunningServer } from "../src/server.js";

let server: RunningServer;
const clients: WebSocket[] = [];

beforeEach(async () => {
  server = await startServer({ port: 0 });
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await server.close();
});

/**
 * A connected peer that mirrors a real `@weaver/sync` client: one `LoroDoc` fed
 * by every inbound frame, plus local edits sent back as update frames.
 *
 * The `message` pump is attached at *construction* (before `open`), so no frame
 * — including a catch-up snapshot the server pushes the instant we register — is
 * ever missed in the gap between `open` and a later listener attach.
 */
interface Peer {
  readonly ws: WebSocket;
  readonly doc: LoroDoc;
  /** Resolve once this peer's body text equals `text`. */
  until(text: string): Promise<void>;
}

function connect(docId: string): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${docId}`);
  ws.binaryType = "arraybuffer";
  clients.push(ws);

  const doc = new LoroDoc();
  const waiters: Array<{ text: string; resolve: () => void }> = [];

  ws.on("message", (data: ArrayBuffer) => {
    doc.import(new Uint8Array(data));
    const text = doc.getText("body").toString();
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.text === text) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  });

  const peer: Peer = {
    ws,
    doc,
    until: (text) =>
      new Promise((resolve) => {
        if (doc.getText("body").toString() === text) resolve();
        else waiters.push({ text, resolve });
      }),
  };

  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(peer));
    ws.on("error", reject);
  });
}

/** Apply a local edit and put the resulting update frame on the wire. */
function edit(peer: Peer, text: string): void {
  const from = peer.doc.version();
  const body = peer.doc.getText("body");
  body.insert(body.length, text);
  peer.doc.commit();
  peer.ws.send(peer.doc.export({ mode: "update", from }));
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
