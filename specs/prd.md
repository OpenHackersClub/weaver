# weaver — Product Requirements

> Status: pre-implementation. This is the product-level brief. Technical detail lives in [`architecture.md`](architecture.md), [`access-control.md`](access-control.md), [`hard-problems.md`](hard-problems.md), [`wasm-strategy.md`](wasm-strategy.md), [`ai-agent.md`](ai-agent.md), and individual [`adr/`](adr/) records.

## 1. Vision

A TypeScript **Notion-style block editor** where **AI agents are first-class collaborators** — not a side-channel chat panel — built on a CRDT (Loro) as the single source of truth, syncing local-first through Cloudflare with server-enforced access control.

In one sentence: **the editor for products where AI agents are co-authors, not assistants.**

## 2. Problem

Today's serious rich-text editor options force a three-way trade-off where one of these is always missing:

| Need | Lexical | ProseMirror+Y.js | Tiptap+Hocuspocus | BlockSuite/AFFiNE |
|---|---|---|---|---|
| **AI agents as CRDT peers** (not just generation-as-API) | ✗ | ✗ | ✗ | ✗ |
| **CRDT as the document model** (no dual state) | ✗ | ✗ | ✗ | ✓ |
| **Local-first by default** (offline; OPFS; org-controlled sync) | ✗ | ✗ | partial | ✓ |

weaver fills the gap: all three together, open-source, in TypeScript, deployable on the org's own Cloudflare edge.

Beyond the three differentiators, weaver also ships **audit-grade attribution** — every accepted edit carries a server-rewritten origin tag and lands in a hash-chained log on R2 — and **org-level data scoping** via tier-partitioned subdocs. Both are table-stakes for regulated industries; few open-source editors ship them out of the box.

## 3. Target users

**Primary** — product engineering teams building agentic document applications:

- A startup building an "AI research assistant" that drafts long-form reports with a human-in-the-loop reviewer.
- A legal-tech / med-tech / finance team that needs AI editors AND audit-grade attribution AND server-enforced confidentiality tiers.
- A consultancy building internal knowledge tools where agents and humans co-author proposals.

**Secondary** — open-source projects and individual developers wanting:

- A Loro-native rich-text editor (the broader ecosystem hasn't built one).
- A headless editor with React chrome but no React-managed editing surface.
- A self-hostable alternative to commercial real-time-collab products.

**Explicitly not for** — teams who need a generic Notion clone with whiteboards and databases (see [BlockSuite/AFFiNE](https://affine.pro)); teams who just need a "rich textarea" with no collab needs (use Tiptap); teams whose AI features are completion-only (use Tiptap Pro or BlockNote).

## 4. Goals

1. **Notion-style block editing** that feels at-par with Notion / BlockSuite-page-mode for the high-leverage 70–80% of doc features.
2. **AI agent as a CRDT peer**, with token streams becoming CRDT ops, scoped capability tokens, visible presence/cursor, and audit-grade attribution.
3. **Local-first**: works offline, persists to OPFS, syncs through Cloudflare Durable Objects.
4. **Audit-grade access control**: per-tier read scoping, per-op write validation, cryptographically attributable changes, immutable audit trail.
5. **Headless core**: the editor library has no React or DOM dependency; React is a chrome adapter.
6. **Plugin extensibility**: third-party block kinds, marks, and AI tools registered via a typed Effect-TS contract.

## 5. Non-goals (v1)

- **Whiteboard / Edgeless / freeform 2D canvas.** Different data model, selection model, access surface. ([ADR 0002](adr/0002-notion-style-block-model.md))
- **Database block** (multi-view Table / Kanban / Calendar / Gallery; formula columns; queries). It's a different product. ([ADR 0002](adr/0002-notion-style-block-model.md))
- **End-to-end encryption.** Mutually exclusive with server-side op validation. ([D16](#10-top-level-decisions-index))
- **100% feature surface of Lexical** day one. Pick the load-bearing subset; rest comes via plugins.
- **Non-CRDT collab transports** (OT, snapshot diffing). CRDT-only.
- **Vue, Svelte, or non-React framework bindings** in v1. React first; others later.

## 6. Key use cases

### 6.1 Human + agent co-authoring a draft

A user types in a doc. They press a key, agent picks up the cursor position, streams a rewrite of the current paragraph. The user sees the agent's edits appear live (CRDT inserts with `origin: agent-N`), visually marked as "uncommitted." The user can keep typing while the agent works — concurrent edits merge as CRDT operations. The user accepts the agent's edits with one keystroke (clears the marker) or rejects (Undo scoped to the agent's origin).

### 6.2 Multi-agent research workflow

Three agents work in parallel on different sections of a doc, each with its own scoped capability token (one rewrites prose, one inserts citations, one builds the outline). Each appears as a separate peer with a presence cursor. They don't interfere; the user supervises from a side panel. Audit log records every accepted edit by agent identity.

### 6.3 Org-scoped enterprise editing with audit attribution

A legal team edits a contract. Three tiers: `public` (anyone with the link), `internal` (firm-wide), `confidential` (deal team). Each tier is a separate LoroDoc; external collaborators receive sync streams only for the public tier. Every accepted op is origin-rewritten to the authenticated subject and appended to a hash-chained immutable audit log on R2 — when compliance asks "who edited this," there's a one-line answer. Users are firm employees and named externals; the trust model is cooperative-org-on-trusted-server (see [ADR 0005](adr/0005-trust-model.md)), not zero-trust insider defense.

### 6.4 Local-first writing with eventual sync

A user drafts on a flight (no network). All edits go into the local LoroDoc, persisted to OPFS. Returning online, the WebSocket reconnects, the DO catches the client up via snapshot + recent updates, the local edits flow through op validation, and concurrent peer edits merge automatically.

## 7. Scope — v1 surface

### Block kinds shipped in v1

`paragraph`, `heading` (levels 1–3 UI; 1–6 schema), `bullet-list-item`, `numbered-list-item`, `to-do`, `toggle`, `quote`, `callout`, `code` (tree-sitter highlighting), `image`, `embed`, `mention`, `divider`, `table` (block-table, not Database).

Full list in [`block-model.md` §3](block-model.md); decision rationale in [ADR 0002](adr/0002-notion-style-block-model.md).

### Marks shipped in v1

`bold`, `italic`, `underline`, `strike`, `code`, `link`, `highlight`, `comment-anchor` (internal), `agent-pending` (internal).

### AI features shipped in v1

- Agent peer runtime (`@weaver/agent`) with attenuated capability tokens
- Streaming generation into `LoroText` with `origin: agent-N`
- Agent presence + scoped cursor in the editor
- Accept / reject overlay (origin-scoped undo)
- Plugin-registered tool catalog, server-enforced

### Access control shipped in v1

- Biscuit capability tokens with attenuation ([ADR 0004](adr/0004-capability-token-format.md))
- D1 ACL store + Workers KV revocation
- WS upgrade gate at the Cloudflare Worker boundary
- **Subdoc partitioning** for read scoping (separate LoroDocs per tier) — load-bearing
- **Tier-write gate** at the DO for write scoping (per-frame check, not per-op validation; see [ADR 0005](adr/0005-trust-model.md))
- Server-authoritative origin rewrite + hash-chained audit log on R2
- Periodic content-integrity sweep with quarantine lane for schema drift (not a hot-path validator)

Full spec: [`access-control.md`](access-control.md).

### Sync & persistence shipped in v1

- OPFS persistence on the client
- Loro sync protocol over WebSocket to Cloudflare Durable Objects
- R2 snapshot storage with GC
- Loro `EphemeralStore` for presence/awareness, filtered by tier and by viewer scope

### Out of scope for v1

- Self-hosted server (Cloudflare-only)
- Vue / Svelte / non-React bindings
- Native mobile apps (web only; mobile browsers supported)
- Notion-style databases / Kanban / Gallery views ([ADR 0002](adr/0002-notion-style-block-model.md))
- Whiteboard / canvas ([ADR 0002](adr/0002-notion-style-block-model.md))
- E2E encryption ([D16](#10-top-level-decisions-index))
- Migration importers from Lexical / Tiptap / Notion HTML (post-v1)

## 8. Success criteria

### Qualitative

- A new contributor can write a plugin (block kind + agent tool) inside one day of reading docs.
- A user accepting an agent's rewrite into a contested paragraph never loses their concurrent typing.
- An admin can revoke a user's access mid-session and the client sees `4001 revoked` within 60 seconds.
- A document with one human + three agents editing concurrently shows no visible jank in cursor or rendering.

### Quantitative

| Metric | Target |
|---|---|
| Cold load of a 100k-op doc | < 800 ms (Loro snapshot + GC) |
| Per-op validation latency in DO | < 5 ms p95 |
| Per-op end-to-end (client commit → broadcast to peer) | < 200 ms p95 same-region |
| Token verification (Biscuit + KV revoke check) | < 1 ms in the hot path (after cache warm) |
| Op rejection roundtrip (server reject → client rollback) | < 100 ms p95 |
| OPFS persist (single commit) | < 10 ms p95 |
| Worker bundle (`@weaver/server`) | < 1 MB gzipped |
| Client bundle (`@weaver/core` + `@weaver/dom` + `@weaver/react` + Loro WASM) | < 600 KB gzipped |

These are targets, not contracts — Phase 0 spike validates whether they're achievable.

## 9. Phased roadmap

### Phase 0 — Foundation spikes (4–6 weeks)

- Loro feasibility prototype: selection model end-to-end with collab + IME using Loro `Cursor`, `LoroTree`, `LoroText`.
- OPFS persistence + LoroDoc cold-load benchmark (snapshot + incremental updates).
- Biscuit token issuance + DO WS upgrade gate skeleton.
- Loro WASM smoke test inside a Cloudflare DO (`workerd`).
- Property tests for the document model (model-check against a TS reference impl).

### Phase 1 — Single-user MVP (8–10 weeks)

- `@weaver/core` + `@weaver/dom` + `@weaver/react` packages.
- Built-in block kinds + marks (per ADR 0002).
- Markdown shortcuts.
- Clipboard (HTML + plain text + Loro-native).
- Loro `UndoManager` integration.
- wa-sqlite mirror with outline + FTS.

### Phase 2 — Collab (6–8 weeks)

- DO + WS sync using Loro's sync protocol over WebSocket.
- Ephemeral / presence via Loro `EphemeralStore`.
- Subdoc partitioning for reads (separate LoroDocs per tier).
- Op validation in DO (Loro WASM).
- Origin rewrite + audit log.

### Phase 3 — AI agent (6–8 weeks)

- Agent peer runtime.
- Tool registry; plugin tool registrations.
- Streaming generation into `LoroText`.
- Agent presence + accept/reject overlay (origin-scoped undo).
- Attenuated agent tokens; tool scoping.

### Phase 4 — Polish & parity (open-ended)

- Code blocks (tree-sitter), tables, images, embeds.
- Suggestion + comment modes (Loro fork-based suggestion mode).
- Accessibility audit (screen readers, keyboard nav).
- Migration importers (from Lexical / Markdown / HTML).

## 10. Top-level decisions index

One-line summaries. Full rationale in linked ADRs and architecture docs.

| # | Decision | Status | Detail |
|---|---|---|---|
| D1 | LoroDoc is the single source of truth; no parallel editor state | [DECIDED] | [`architecture.md` §2](architecture.md#2-document-model--lorodoc-as-single-source-of-truth) |
| D2 | History via Loro peer-scoped `UndoManager` + origin tags | [DECIDED] | [`architecture.md` §2](architecture.md#2-document-model--lorodoc-as-single-source-of-truth) |
| D3 | Effect-TS at the boundaries, not the hot path | [DECIDED] | [`architecture.md` §4](architecture.md#4-effect-ts--where-it-shines-where-it-doesnt) |
| D4 | Ephemeral UI state lives in Effect-TS `SubscriptionRef` stores (Layer-injected); never document state | [DECIDED] | [ADR 0007](adr/0007-ui-state-effect-over-valtio.md), [`block-model.md` §6](block-model.md), [`architecture.md` §3](architecture.md#3-reactivity--state) |
| D5 | React renders chrome; editing surface is imperative DOM | [DECIDED] | [`architecture.md` §1](architecture.md#1-system-overview) |
| D6 | Loro (Rust-native CRDT, WASM build) as the CRDT core | [DECIDED] | [ADR 0001](adr/0001-adopt-loro-over-yjs.md) |
| D7 | Subdoc partitioning for read access control | [DECIDED] | [`access-control.md` §5](access-control.md) |
| D8 | Server-authoritative op validation in DO | [DECIDED] | [`access-control.md` §6](access-control.md) |
| D9 | AI agents connect as LoroDoc peers | [DECIDED] | [`ai-agent.md`](ai-agent.md) |
| D10 | Plugin contract = Effect-TS Layer | [DECIDED] | [`architecture.md` §5](architecture.md#5-plugin-architecture) |
| D11 | Cloudflare Durable Object per document | [DECIDED] | [`architecture.md` §6](architecture.md#6-sync-architecture) |
| D12 | wa-sqlite + OPFS as a local read-model mirror | [DECIDED] | [`wasm-strategy.md`](wasm-strategy.md) |
| D13 | Y.js vs Loro evaluation | [CLOSED] | Resolved in [ADR 0001](adr/0001-adopt-loro-over-yjs.md) |
| D14 | Selection model design must precede everything else | [DECIDED] | [`hard-problems.md` §1](hard-problems.md) |
| D15 | Capability tokens via Biscuit | [DECIDED] | [ADR 0004](adr/0004-capability-token-format.md) |
| D16 | No end-to-end encryption in v1 | [DECIDED] | Trade-off; see `access-control.md` §0 |
| D17 | Notion-style block model; no whiteboard or DB | [DECIDED] | [ADR 0002](adr/0002-notion-style-block-model.md) |
| D18 | Per-scenario concurrent semantics; no global RW/AW | [DECIDED] | [ADR 0003](adr/0003-concurrent-semantics-no-global-rw-aw.md) |
| D19 | Cooperative-org trust model; sync server is trusted; access control is org-level data scoping (not zero-trust insider defense) | [DECIDED] | [ADR 0005](adr/0005-trust-model.md) |
| D20 | AI agent threat model: capability scope is the durable bound; prompt-injection defenses are best-effort | [DECIDED] | [ADR 0006](adr/0006-ai-agent-threat-model.md) |

## 11. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Loro corner-case bugs (younger than Y.js) | medium | high | Property tests in Phase 0; thin adapter in `@weaver/wasm`; ADR 0001 reversibility plan |
| Selection on CRDT harder than estimated (4–6w spike) | high | high | Design first, in Phase 0, before any other implementation |
| Loro `Cursor` ↔ DOM Selection bugs at scale | medium | high | Phase 0 covers multi-peer + IME explicitly |
| Effect-TS adoption curve scares contributors | medium | medium | Templates; plain-TS escape hatch for trivial plugins |
| Op-validation perf in DO too slow (>5 ms per op) | low | high | Loro diff API is single-digit ms in benchmarks; profile in Phase 2 |
| `biscuit-auth-wasm` maintenance stalls | low | medium | Wrapper interface in `@weaver/server`; Macaroons fallback impl shipped in Phase 0 ([ADR 0004](adr/0004-capability-token-format.md)) |
| BlockSuite catches up on agent-as-peer | medium | medium | Our remaining differentiation: Effect-TS plugin contract; subdoc-partitioned ACL; Cloudflare-native; Loro from day one |
| CRDT-native rich-text on Loro is harder than expected (no reference editor exists) | medium | high | `loro-prosemirror` as the closest reference; property tests for concurrent marks |
| Programmatic writes (AI, importer) collide with user cursors via delete-then-insert | medium | high | Mandate "diff-and-apply-minimal-ops" for any programmatic write; documented in [ADR 0003](adr/0003-concurrent-semantics-no-global-rw-aw.md) and revisit in Phase 3 |

## 12. Open questions

- **[OPEN]** Historical content access policy default. Probably "grant grants history" but confirm with first customer. ([`access-control.md` §8.9](access-control.md))
- **[OPEN]** Server-side schema validation language. Effect Schema in a JS isolate inside the DO is the default; port to Rust if profile demands.
- **[OPEN]** Disaster recovery for corrupted LoroDocs. Loro's `checkout()` + new-doc-from-snapshot makes this tractable; spec the operator runbook.
- **[OPEN]** Rate limiting at the DO. Per-user op rate; cap on tx size.
- **[OPEN]** Test strategy for op-validation correctness — property tests against the Loro diff decomposer.
- **[OPEN]** Loro version pinning + upgrade cadence. Adapter contains the surface, but major-version bumps are ADR-worthy.

## 13. Document map

- [`prd.md`](prd.md) — this file: product vision, scope, roadmap, decisions index.
- [`architecture.md`](architecture.md) — system overview, document model, reactivity, Effect-TS scoping, plugin contract, sync architecture, tradeoffs.
- [`hard-problems.md`](hard-problems.md) — selection, schema, coalescing, parity, AI streaming, perf, concurrent semantics.
- [`wasm-strategy.md`](wasm-strategy.md) — Zero pattern + 5 concrete WASM uses.
- [`ai-agent.md`](ai-agent.md) — agent peer model, presence, tools, streaming UX, access control summary.
- [`access-control.md`](access-control.md) — full access-control spec (identity, tokens, schemas, op validation, audit, threat model, gaps).
- [`comparison.md`](comparison.md) — weaver vs other editors.
- [`adr/`](adr/) — individual decision records (Loro adoption, block model, concurrent semantics, capability token format).
