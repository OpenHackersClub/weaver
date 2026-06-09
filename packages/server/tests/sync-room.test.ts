import { Effect, Either } from "effect";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  FrameImportError,
  type PeerConnection,
  SyncRoom,
} from "../src/sync-room.js";

/**
 * A fake peer that mirrors what `@weaver/sync`'s client does on the other end
 * of the wire: it owns its own `LoroDoc` and imports every frame the room
 * relays to it. `sends` counts deliveries so we can assert echo suppression.
 */
class FakePeer implements PeerConnection {
  readonly id: string;
  readonly doc = new LoroDoc();
  sends = 0;

  constructor(id: string) {
    this.id = id;
  }

  send(frame: Uint8Array): void {
    this.sends += 1;
    this.doc.import(frame);
  }

  /** Edit locally and return the update frame the client would put on the wire. */
  edit(text: string): Uint8Array {
    const from = this.doc.version();
    this.doc.getText("body").insert(this.doc.getText("body").length, text);
    this.doc.commit();
    return this.doc.export({ mode: "update", from });
  }
}

const text = (doc: LoroDoc): string => doc.getText("body").toString();

describe("SyncRoom", () => {
  it("relays a local edit to every other peer and converges", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    const b = new FakePeer("b");
    room.register(a);
    room.register(b);

    const frame = a.edit("hello");
    Effect.runSync(room.receiveFrame(a, frame));

    expect(text(b.doc)).toBe("hello");
    // Echo suppression: the sender never receives its own frame back.
    expect(a.sends).toBe(0);
    expect(b.sends).toBe(1);
  });

  it("converges two peers editing concurrently", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    const b = new FakePeer("b");
    room.register(a);
    room.register(b);

    Effect.runSync(room.receiveFrame(a, a.edit("A")));
    Effect.runSync(room.receiveFrame(b, b.edit("B")));

    // Both peers see both edits and agree on the result.
    expect(text(a.doc)).toBe(text(b.doc));
    expect(text(a.doc).length).toBe(2);
  });

  it("catches up a late joiner with a snapshot, then live edits flow", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    room.register(a);
    Effect.runSync(room.receiveFrame(a, a.edit("early")));

    // A new peer joins after the edit and is brought current via snapshot.
    const c = new FakePeer("c");
    room.register(c);
    const snapshot = room.catchUpSnapshot();
    expect(snapshot).not.toBeNull();
    c.doc.import(snapshot!);
    expect(text(c.doc)).toBe("early");

    // Subsequent live edits reach the now-registered joiner.
    Effect.runSync(room.receiveFrame(a, a.edit(" late")));
    expect(text(c.doc)).toBe("early late");
  });

  it("returns no snapshot for an empty room", () => {
    const room = new SyncRoom();
    expect(room.catchUpSnapshot()).toBeNull();
  });

  it("drops a malformed frame without relaying or mutating canonical state", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    const b = new FakePeer("b");
    room.register(a);
    room.register(b);

    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37]);
    const result = Effect.runSync(room.receiveFrame(a, garbage).pipe(Effect.either));

    Either.match(result, {
      onLeft: (error) => {
        expect(error).toBeInstanceOf(FrameImportError);
        expect(error.connectionId).toBe("a");
      },
      onRight: () => {
        throw new Error("expected the malformed frame to fail");
      },
    });
    // Nothing relayed; canonical doc still empty.
    expect(b.sends).toBe(0);
    expect(room.catchUpSnapshot()).toBeNull();
  });

  it("rehydrates canonical state from a persisted snapshot", () => {
    // Simulate a prior session: a doc with content, exported as a snapshot.
    const prior = new LoroDoc();
    prior.getText("body").insert(0, "persisted");
    prior.commit();
    const persisted = prior.export({ mode: "snapshot" });

    const room = new SyncRoom();
    Effect.runSync(room.hydrate(persisted));

    // A peer joining the rebuilt room sees the persisted content.
    const c = new FakePeer("c");
    room.register(c);
    const snapshot = room.catchUpSnapshot();
    expect(snapshot).not.toBeNull();
    c.doc.import(snapshot!);
    expect(text(c.doc)).toBe("persisted");
  });

  it("stops relaying to an unregistered peer", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    const b = new FakePeer("b");
    room.register(a);
    room.register(b);
    room.unregister("b");

    Effect.runSync(room.receiveFrame(a, a.edit("x")));
    expect(b.sends).toBe(0);
  });

  it("counts pending frames for snapshot cadence and resets on persist", () => {
    const room = new SyncRoom();
    const a = new FakePeer("a");
    room.register(a);

    Effect.runSync(room.receiveFrame(a, a.edit("1")));
    Effect.runSync(room.receiveFrame(a, a.edit("2")));
    expect(room.pendingFrames).toBe(2);

    room.markSnapshotPersisted();
    expect(room.pendingFrames).toBe(0);
  });
});

it("FrameImportError carries the offending connection id", () => {
  const error = new FrameImportError({ connectionId: "a", cause: "boom" });
  expect(error.connectionId).toBe("a");
  expect(error._tag).toBe("FrameImportError");
});
