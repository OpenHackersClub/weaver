import { Effect, Either } from "effect";
import { EphemeralStore, LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrameDecodeError,
  FrameKind,
  decodeFrame,
  encodeFrame,
} from "../src/frame.js";
import {
  FrameImportError,
  type PeerConnection,
  SyncRoom,
} from "../src/sync-room.js";

/**
 * A fake peer that mirrors what `@weaver/sync`'s client does on the other end
 * of the wire: it owns its own `LoroDoc` + presence `EphemeralStore` and
 * demuxes every relayed frame by its kind tag. `sends` counts deliveries so we
 * can assert echo suppression.
 */
class FakePeer implements PeerConnection {
  readonly id: string;
  readonly doc = new LoroDoc();
  readonly presence = new EphemeralStore(60_000);
  sends = 0;

  constructor(id: string) {
    this.id = id;
  }

  send(frame: Uint8Array): void {
    this.sends += 1;
    Either.match(decodeFrame(frame), {
      onLeft: () => {
        throw new Error("relayed an undecodable frame");
      },
      onRight: ({ kind, body }) => {
        if (kind === FrameKind.Doc) this.doc.import(body);
        else this.presence.apply(body);
      },
    });
  }

  /** Edit locally and return the tagged frame the client would put on the wire. */
  edit(text: string): Uint8Array {
    const from = this.doc.version();
    this.doc.getText("body").insert(this.doc.getText("body").length, text);
    this.doc.commit();
    return encodeFrame(FrameKind.Doc, this.doc.export({ mode: "update", from }));
  }

  /** Publish a presence record and return the tagged wire frame. */
  announce(label: string): Uint8Array {
    this.presence.set(this.id, { peerId: this.id, label });
    return encodeFrame(FrameKind.Presence, this.presence.encode(this.id));
  }

  dispose(): void {
    this.presence.destroy();
  }
}

const text = (doc: LoroDoc): string => doc.getText("body").toString();

describe("frame codec", () => {
  it("round-trips both kinds and preserves the body", () => {
    const body = new Uint8Array([1, 2, 3]);
    for (const kind of [FrameKind.Doc, FrameKind.Presence]) {
      const decoded = Either.getOrThrow(decodeFrame(encodeFrame(kind, body)));
      expect(decoded.kind).toBe(kind);
      expect(Array.from(decoded.body)).toEqual([1, 2, 3]);
    }
  });

  it("rejects empty frames and unknown tags", () => {
    for (const bad of [new Uint8Array([]), new Uint8Array([0x6c, 0x6f])]) {
      Either.match(decodeFrame(bad), {
        onLeft: (e) => expect(e).toBeInstanceOf(FrameDecodeError),
        onRight: () => {
          throw new Error("expected decode failure");
        },
      });
    }
  });
});

describe("SyncRoom", () => {
  const rooms: SyncRoom[] = [];
  const peers: FakePeer[] = [];
  const makeRoom = (): SyncRoom => {
    const room = new SyncRoom();
    rooms.push(room);
    return room;
  };
  const makePeer = (id: string): FakePeer => {
    const peer = new FakePeer(id);
    peers.push(peer);
    return peer;
  };
  afterEach(() => {
    for (const room of rooms.splice(0)) room.dispose();
    for (const peer of peers.splice(0)) peer.dispose();
  });

  it("relays a local edit to every other peer and converges", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
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
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);

    Effect.runSync(room.receiveFrame(a, a.edit("A")));
    Effect.runSync(room.receiveFrame(b, b.edit("B")));

    // Both peers see both edits and agree on the result.
    expect(text(a.doc)).toBe(text(b.doc));
    expect(text(a.doc).length).toBe(2);
  });

  it("relays presence to every other peer without touching the doc", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);

    Effect.runSync(room.receiveFrame(a, a.announce("Ada")));

    expect(b.presence.get("a")).toMatchObject({ label: "Ada" });
    expect(a.sends).toBe(0);
    // No doc content was created and no snapshot cadence consumed.
    expect(room.catchUpFrames().length).toBe(1); // presence only, no doc frame
    expect(room.pendingFrames).toBe(0);
  });

  it("catches up a late joiner with doc + presence frames, then live edits flow", () => {
    const room = makeRoom();
    const a = makePeer("a");
    room.register(a);
    Effect.runSync(room.receiveFrame(a, a.edit("early")));
    Effect.runSync(room.receiveFrame(a, a.announce("Ada")));

    // A new peer joins after the fact and converges from catch-up frames alone.
    const c = makePeer("c");
    room.register(c);
    for (const frame of room.catchUpFrames()) c.send(frame);
    expect(text(c.doc)).toBe("early");
    expect(c.presence.get("a")).toMatchObject({ label: "Ada" });

    // Subsequent live edits reach the now-registered joiner.
    Effect.runSync(room.receiveFrame(a, a.edit(" late")));
    expect(text(c.doc)).toBe("early late");
  });

  it("returns no catch-up frames for an empty room", () => {
    expect(makeRoom().catchUpFrames()).toEqual([]);
  });

  it("drops an unknown-tag frame without relaying", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);

    // 0xff is no known frame kind.
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37]);
    const result = Effect.runSync(room.receiveFrame(a, garbage).pipe(Effect.either));

    Either.match(result, {
      onLeft: (error) => expect(error).toBeInstanceOf(FrameDecodeError),
      onRight: () => {
        throw new Error("expected the unknown tag to fail");
      },
    });
    expect(b.sends).toBe(0);
  });

  it("drops a malformed doc body without relaying or mutating canonical state", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);

    const garbage = encodeFrame(FrameKind.Doc, new Uint8Array([0xff, 0x13, 0x37]));
    const result = Effect.runSync(room.receiveFrame(a, garbage).pipe(Effect.either));

    Either.match(result, {
      onLeft: (error) => {
        expect(error).toBeInstanceOf(FrameImportError);
        expect((error as FrameImportError).connectionId).toBe("a");
      },
      onRight: () => {
        throw new Error("expected the malformed frame to fail");
      },
    });
    // Nothing relayed; canonical doc still empty.
    expect(b.sends).toBe(0);
    expect(room.catchUpFrames()).toEqual([]);
  });

  it("drops a malformed presence body without relaying", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);

    const garbage = encodeFrame(
      FrameKind.Presence,
      new Uint8Array([0xff, 0x13, 0x37]),
    );
    const result = Effect.runSync(room.receiveFrame(a, garbage).pipe(Effect.either));

    expect(Either.isLeft(result)).toBe(true);
    expect(b.sends).toBe(0);
  });

  it("rehydrates canonical state from a persisted snapshot", () => {
    // Simulate a prior session: a doc with content, exported as a snapshot.
    const prior = new LoroDoc();
    prior.getText("body").insert(0, "persisted");
    prior.commit();
    const persisted = prior.export({ mode: "snapshot" });

    const room = makeRoom();
    Effect.runSync(room.hydrate(persisted));

    // A peer joining the rebuilt room sees the persisted content.
    const c = makePeer("c");
    room.register(c);
    for (const frame of room.catchUpFrames()) c.send(frame);
    expect(text(c.doc)).toBe("persisted");
  });

  it("stops relaying to an unregistered peer", () => {
    const room = makeRoom();
    const a = makePeer("a");
    const b = makePeer("b");
    room.register(a);
    room.register(b);
    room.unregister("b");

    Effect.runSync(room.receiveFrame(a, a.edit("x")));
    expect(b.sends).toBe(0);
  });

  it("counts doc frames for snapshot cadence — presence never counts", () => {
    const room = makeRoom();
    const a = makePeer("a");
    room.register(a);

    Effect.runSync(room.receiveFrame(a, a.edit("1")));
    Effect.runSync(room.receiveFrame(a, a.announce("Ada")));
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
