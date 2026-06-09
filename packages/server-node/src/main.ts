import { fileStore, inMemoryStore } from "./persistence.js";
import { startServer } from "./server.js";

/**
 * Standalone entrypoint (`tsx src/main.ts`). Config via env:
 *   - `PORT`            listen port (default 8787)
 *   - `WEAVER_DATA_DIR` if set, persist snapshots to this dir (else in-memory)
 */
const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.WEAVER_DATA_DIR;
const store = dataDir ? fileStore(dataDir) : inMemoryStore();

startServer({ port, store })
  .then((server) => {
    console.log(
      `[weaver/server-node] listening on :${server.port} — ws /ws/:docId, GET /health ` +
        (dataDir ? `(snapshots → ${dataDir})` : "(in-memory snapshots)"),
    );
  })
  .catch((error: unknown) => {
    console.error("[weaver/server-node] failed to start", error);
    process.exitCode = 1;
  });
