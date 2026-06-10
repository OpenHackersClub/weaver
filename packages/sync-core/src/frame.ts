import { Either, Schema } from "effect";

/**
 * Wire framing for the Loro sync protocol (`specs/presence.md` §Wire protocol).
 *
 * Phase 2a put bare Loro update blobs on the WebSocket. Presence introduces a
 * second payload kind, so every frame now carries a 1-byte tag prefix:
 *
 *   - `0x00` doc      — Loro update / snapshot blob (`doc.export(…)`)
 *   - `0x01` presence — `EphemeralStore` encoded update (never persisted)
 *
 * The tag is deliberately the *outermost* layer: the Phase 2b per-tier
 * filtered broadcast can route presence per-recipient without decoding Loro
 * internals. Storage formats (DO snapshots, OPFS op-logs) stay untagged raw
 * blobs — the tag exists only on the wire.
 */

export const FrameKind = {
  Doc: 0x00,
  Presence: 0x01,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface DecodedFrame {
  readonly kind: FrameKind;
  readonly body: Uint8Array;
}

/** The frame was empty or carried an unknown tag byte. Drop it (never relay). */
export class FrameDecodeError extends Schema.TaggedError<FrameDecodeError>()(
  "FrameDecodeError",
  {
    reason: Schema.String,
  },
) {}

export const encodeFrame = (kind: FrameKind, body: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(body.length + 1);
  frame[0] = kind;
  frame.set(body, 1);
  return frame;
};

export const decodeFrame = (
  frame: Uint8Array,
): Either.Either<DecodedFrame, FrameDecodeError> => {
  if (frame.length === 0) {
    return Either.left(new FrameDecodeError({ reason: "empty frame" }));
  }
  const tag = frame[0];
  if (tag !== FrameKind.Doc && tag !== FrameKind.Presence) {
    return Either.left(
      new FrameDecodeError({ reason: `unknown frame tag 0x${tag!.toString(16)}` }),
    );
  }
  return Either.right({ kind: tag, body: frame.subarray(1) });
};
