import type { Env } from "./durable-object.js";

export { WeaverSyncDO } from "./durable-object.js";

/** `/ws/<docId>` — the doc id may contain slashes (e.g. nested paths). */
const WS_PATH = /^\/ws\/(.+)$/;

/**
 * Cloudflare Worker entry. Routes a WebSocket upgrade for `/ws/:docId` to the
 * per-document `WeaverSyncDO` (one DO instance per `idFromName(docId)`), and
 * answers `GET /health` for liveness checks.
 *
 * The auth gate lives HERE (Phase 2b): before forwarding the upgrade we will
 * verify the Biscuit token from `Sec-WebSocket-Protocol`, resolve the D1 ACL
 * for `(subject, doc)`, and reject unauthorized upgrades — see
 * `specs/access-control.md` §"WS upgrade flow". Today every upgrade for a
 * well-formed path is forwarded; the DO trusts its peers.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", service: "weaver-sync" });
    }

    const match = WS_PATH.exec(url.pathname);
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    const docId = decodeURIComponent(match[1]!);
    const id = env.WEAVER_SYNC.idFromName(docId);
    const stub = env.WEAVER_SYNC.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
