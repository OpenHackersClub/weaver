import { LoroDoc } from "loro-crdt";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it } from "vitest";
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

/** Open a binary WS client against the running server and resolve once it's open. */
function connect(docId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${docId}`);
  ws.binaryType = "arraybuffer";
  clients.push(ws);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** The update frame a client would put on the wire after a local edit. */
function edit(doc: LoroDoc, text: string): Uint8Array {
  const from = doc.version();
  const body = doc.getText("body");
  body.insert(body.length, text);
  doc.commit();
  return doc.export({ mode: "update", from });
}

const bodyText = (doc: LoroDoc): string => doc.getText("body").toString();

/** Resolve once `doc` (fed by ws frames) reaches `expected`. */
function awaitText(ws: WebSocket, doc: LoroDoc, expected: string): Promise<void> {
  return new Promise((resolve) => {
    ws.on("message", (data: ArrayBuffer) => {
      doc.import(new Uint8Array(data));
      if (bodyText(doc) === expected) resolve();
    });
  });
}

it("answers GET /health", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", service: "weaver-sync-node" });
});

it("relays a local edit between two ws peers and converges", async () => {
  const aWs = await connect("demo");
  const bWs = await connect("demo");

  const bDoc = new LoroDoc();
  const bConverged = awaitText(bWs, bDoc, "hello");

  const aDoc = new LoroDoc();
  aWs.send(edit(aDoc, "hello"));

  await bConverged;
  expect(bodyText(bDoc)).toBe("hello");
});

it("catches up a late joiner with the canonical snapshot", async () => {
  const aWs = await connect("late");
  const bWs = await connect("late");

  // Drive an edit and wait for b to receive it — this proves the server has
  // imported the frame into the canonical room before the late peer joins.
  const bDoc = new LoroDoc();
  const bGotIt = awaitText(bWs, bDoc, "early");
  const aDoc = new LoroDoc();
  aWs.send(edit(aDoc, "early"));
  await bGotIt;

  // A fresh peer joining now must be brought current via the catch-up snapshot.
  const cDoc = new LoroDoc();
  const cWs = await connect("late");
  const cCaughtUp = awaitText(cWs, cDoc, "early");
  await cCaughtUp;
  expect(bodyText(cDoc)).toBe("early");
});

it("isolates docs — an edit in one room never reaches another", async () => {
  const aWs = await connect("room-a");
  const bWs = await connect("room-b");

  let bReceived = 0;
  bWs.on("message", () => {
    bReceived += 1;
  });

  // A second peer in room-a confirms the edit was actually relayed somewhere.
  const a2Ws = await connect("room-a");
  const a2Doc = new LoroDoc();
  const a2Converged = awaitText(a2Ws, a2Doc, "scoped");

  const aDoc = new LoroDoc();
  aWs.send(edit(aDoc, "scoped"));
  await a2Converged;

  expect(bReceived).toBe(0);
});
