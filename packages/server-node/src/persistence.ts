import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";

/**
 * A failed snapshot read/write. The relay never depends on persistence for
 * correctness (the canonical doc lives in memory), so callers log-and-continue
 * on these rather than failing a connection.
 */
export class SnapshotStoreError extends Schema.TaggedError<SnapshotStoreError>()(
  "SnapshotStoreError",
  {
    docId: Schema.String,
    op: Schema.Literal("load", "save"),
    cause: Schema.Unknown,
  },
) {}

/**
 * Durable home for a doc's canonical snapshot — the Node analogue of the DO's
 * `ctx.storage` slot. Snapshot-only (no op-log), matching `@weaver/server`'s
 * MVP persistence; an op-log + cold-storage split is the same Phase 2b
 * follow-up the DO defers.
 */
export interface SnapshotStore {
  load(docId: string): Effect.Effect<Uint8Array | null, SnapshotStoreError>;
  save(docId: string, bytes: Uint8Array): Effect.Effect<void, SnapshotStoreError>;
}

/** Ephemeral store — snapshots live only as long as the process. Fine for a demo. */
export function inMemoryStore(): SnapshotStore {
  const snapshots = new Map<string, Uint8Array>();
  return {
    load: (docId) => Effect.sync(() => snapshots.get(docId) ?? null),
    save: (docId, bytes) =>
      Effect.sync(() => {
        snapshots.set(docId, bytes);
      }),
  };
}

/**
 * Filesystem store writing one `<dir>/<docId>.bin` per doc, so a mounted volume
 * survives restarts. Doc ids may contain slashes (nested paths), so they are
 * percent-encoded into a flat filename.
 */
export function fileStore(dir: string): SnapshotStore {
  const pathFor = (docId: string) => join(dir, `${encodeURIComponent(docId)}.bin`);
  return {
    load: (docId) =>
      Effect.tryPromise({
        try: () => readFile(pathFor(docId)),
        catch: (cause) => new SnapshotStoreError({ docId, op: "load", cause }),
      }).pipe(
        Effect.map((buf) => new Uint8Array(buf)),
        // A missing file just means "no prior snapshot", not an error.
        Effect.catchTag("SnapshotStoreError", (error) =>
          isNotFound(error.cause) ? Effect.succeed(null) : Effect.fail(error),
        ),
      ),
    save: (docId, bytes) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dir, { recursive: true });
          // Write to a temp file then rename — rename is atomic on a single
          // filesystem, so a crash (or a concurrent reader) never sees a torn
          // half-written snapshot.
          const finalPath = pathFor(docId);
          const tmpPath = `${finalPath}.tmp-${process.pid}-${(tmpCounter += 1)}`;
          await writeFile(tmpPath, bytes);
          await rename(tmpPath, finalPath);
        },
        catch: (cause) => new SnapshotStoreError({ docId, op: "save", cause }),
      }),
  };
}

/** Monotonic suffix to keep concurrent temp-file names distinct within a process. */
let tmpCounter = 0;

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: string }).code === "ENOENT"
  );
}
