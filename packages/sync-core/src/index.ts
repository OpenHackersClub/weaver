export {
  type PeerConnection,
  SyncRoom,
  FrameImportError,
  SNAPSHOT_EVERY_N_FRAMES,
  PRESENCE_REPLICA_TIMEOUT_MS,
} from "./sync-room.js";
export {
  FrameKind,
  type DecodedFrame,
  FrameDecodeError,
  encodeFrame,
  decodeFrame,
} from "./frame.js";
