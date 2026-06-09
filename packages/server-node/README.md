# @weaver/server-node

A portable Node [`ws`](https://github.com/websockets/ws) adapter for
[`@weaver/sync-core`](../sync-core) — the same transport-agnostic Loro relay that
backs the Cloudflare Durable Object ([`@weaver/server`](../server)), but as a
long-lived WebSocket server you can run in a container on AWS or any host.

It is a **bare relay**: any client that connects to `/ws/:docId` joins that
document's room. Auth (Biscuit tokens), subdoc partitioning, op-validation, and
cold-snapshot GC remain the Cloudflare-side Phase 2b work described in
[`specs/access-control.md`](../../specs/access-control.md) and ADR 0004/0005.

## Protocol

Identical wire format to the Durable Object and to `@weaver/sync`'s `WsBridge`:
each binary frame is a raw Loro update blob (`doc.export({ mode: "update", from })`).
On connect, the server pushes a catch-up snapshot; thereafter it imports each
inbound frame into the canonical `LoroDoc` and relays the raw bytes to every
other peer (echo-suppressed by connection id).

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ "status": "ok", "service": "weaver-sync-node" }` |
| `GET /ws/:docId` (Upgrade) | Join the relay room for `docId` |

## Run locally

```sh
pnpm --filter @weaver/server-node dev      # tsx watch, :8787
curl localhost:8787/health
```

Point `@weaver/sync`'s `WsBridge` at `ws://localhost:8787/ws/<docId>` — no client
change; the bridge is already URL-agnostic with reconnect/backoff.

Config via env:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `WEAVER_DATA_DIR` | _(unset)_ | If set, persist canonical snapshots to `<dir>/<docId>.bin` (else in-memory only) |

## Container

```sh
# Build context is the repo root (pnpm workspace).
docker build -f packages/server-node/Dockerfile -t weaver-sync-node .
docker run -p 8787:8787 weaver-sync-node
# Persist snapshots across restarts:
docker run -p 8787:8787 -e WEAVER_DATA_DIR=/data -v weaver-data:/data weaver-sync-node
```

## Deploy to AWS

The container is the artifact; AWS just needs a WS-capable, long-lived runtime.

### Recommended: ECS Fargate behind an ALB

An Application Load Balancer upgrades WebSocket connections natively.

1. `docker build -f packages/server-node/Dockerfile -t weaver-sync-node .`
2. Push to ECR (`aws ecr create-repository …`, `docker tag`, `docker push`).
3. Fargate service running the image; container port `8787`.
4. ALB target group → health check `GET /health`; listener forwards `/ws/*`
   (and `/health`) to the target group.

> **Single authoritative replica.** Each process is the source of truth for the
> rooms it serves (the Node analogue of "one Durable Object per doc"). Run **one
> task** for correctness. Scaling out needs docId-sticky routing (so every peer
> of a doc lands on the same task) or a shared coordination backend — a
> follow-up, mirroring the spec's "DOs are single-region" note
> ([`specs/access-control.md` §19](../../specs/access-control.md)). For
> snapshot durability across task restarts, mount an EFS volume and set
> `WEAVER_DATA_DIR`.

### Alternatives

- **App Runner** — simplest if WebSockets are supported in your region; point it
  at the image, port `8787`, health check `/health`.
- **Single EC2 host** — run the container directly; terminate TLS at the
  instance or a CloudFront/ALB in front.

Clients then connect to `wss://<host>/ws/<docId>`.
