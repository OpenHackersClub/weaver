# weaver

A TypeScript rich-text editor with **LoroDoc as the single source of truth**, designed for AI agents as a first-class collaborative peer.

**Docs site** — <https://weaver-docs.pages.dev> (default CF Pages subdomain; `weaver.openhackers.club` once DNS is in place).
**Playground** — to come; spec at [`specs/playground.md`](./specs/playground.md).

> Status: pre-implementation. Start with [`specs/prd.md`](./specs/prd.md) for the product brief, then drill into [`specs/architecture.md`](./specs/architecture.md), [`specs/access-control.md`](./specs/access-control.md), [`specs/hard-problems.md`](./specs/hard-problems.md), [`specs/wasm-strategy.md`](./specs/wasm-strategy.md), [`specs/ai-agent.md`](./specs/ai-agent.md). [`specs/adr/`](./specs/adr/) holds individual decision records; [`specs/comparison.md`](./specs/comparison.md) compares weaver with other editors. [`specs/lexical-parity.md`](./specs/lexical-parity.md) catalogs the Lexical feature subset we commit to; [`specs/benchmarks.md`](./specs/benchmarks.md) defines the perf bar.

## Design pillars

- **LoroDoc is truth.** No parallel state model; history is powered by Loro change events with peer-scoped undo.
- **Local-first.** OPFS-persisted, offline-first; syncs through Cloudflare Durable Objects.
- **Headless core.** No React or DOM dependency in the editor core.
- **Plugin architecture** built on Effect-TS Layer composition.
- **AI agents as LoroDoc peers** — not a bolted-on chat panel.

## Stack (proposed)

- [Loro](https://loro.dev) (Rust-native CRDT, WASM build) — CRDT core, client + server. See [ADR 0001](./specs/adr/0001-adopt-loro-over-yjs.md).
- wa-sqlite + OPFS — local read-model mirror for queries / FTS / agent context
- Effect-TS — commands, plugins, AI workflows, sync orchestration, *and* ephemeral UI state via `SubscriptionRef` ([ADR 0007](./specs/adr/0007-ui-state-effect-over-valtio.md))
- React — chrome (toolbars, panels) only; editor surface is imperative
- Cloudflare Durable Objects + R2 + D1 — sync, storage, access control

See [`specs/prd.md`](./specs/prd.md) for the product brief and [`specs/architecture.md`](./specs/architecture.md) for the technical rationale and tradeoffs.
