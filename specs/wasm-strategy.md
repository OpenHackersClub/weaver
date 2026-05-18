# weaver — WASM Strategy

> Where WASM earns its keep in weaver, what we steal from [Zero](https://zero.rocicorp.dev), and what WASM doesn't help with. Companion to [`architecture.md`](architecture.md).

## 1. What Zero actually does (worth being precise)

Zero (Rocicorp) isn't "fast JS via WASM" — it's a different architecture made possible by WASM:

1. **WASM SQLite on the client** (wa-sqlite + OPFS persistence). Not a key-value store — a real relational DB. ZQL queries run against this local SQLite with indexes, JOINs, ORDER BY.
2. **Reactive queries over the local DB.** When the DB changes, subscribed queries re-fire — the React UI re-renders only on relevant query results, not on every sync delta.
3. **Server is a Postgres logical-replication source + a permission filter.** Server doesn't store client state; it streams filtered ops down. Permissions are enforced as filters on the replication stream, not as RPC checks.
4. **WASM lets the server-side filter be deterministic with the client read model.** Same query engine logic on both sides.

**The transferable insight:** WASM enables a real DB in the browser, which enables read-model–driven access control, which enables instantaneous reads without round-trip auth checks. That's the move worth stealing — not SQLite specifically.

## 2. Five concrete WASM uses

### 2.1 CRDT core — Loro [DECIDED — [ADR 0001](adr/0001-adopt-loro-over-yjs.md)]

| Operation | JS Yjs | Yrs WASM | **Loro WASM** | Why it matters |
|---|---|---|---|---|
| Apply 100k-op update | 800–1500 ms | ~120 ms | **~25–40 ms** | Cold-start a doc from snapshot |
| Encode state vector | 50–100 ms | 5–15 ms | **2–5 ms** | Per-tick sync |
| Memory per op | ~120 B | ~32 B | **~16–24 B** | 100k+ op docs |
| GC pauses | Yes | None | **None** | Smooth typing |
| Rich-text marks | attribute layer (concurrent edge cases) | same | **native CRDT type** | Concurrent format ops well-defined |
| Per-peer undo | manual origin filter | manual origin filter | **native** | No foot-gun on agent edits |
| Version control (fork, time travel) | external snapshot diffing | same | **native API** | Suggestion mode, preview-then-commit |

Crucially: **Loro's diff API exposes ops with already-resolved container targets** — the foundation of server-side op-level access control. The DO validates ops by container path without re-walking the doc state.

Run the **same Loro WASM in the client and in the Cloudflare DO** (Loro ships a single WASM build usable in both browsers and `workerd`).

### 2.2 Client-side SQLite mirror — the Zero move [DECIDED]

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,        -- LoroTreeNode ID
  type TEXT NOT NULL,         -- 'paragraph', 'heading', 'image', ...
  parent_id TEXT,
  position INTEGER,
  attrs JSON,
  text_preview TEXT,          -- first 200 chars
  agent_origin TEXT,          -- which agent (if any) created this
  acl_tag TEXT,               -- 'public' / 'internal' / 'confidential'
  updated_at INTEGER
);
CREATE INDEX nodes_type ON nodes(type);
CREATE INDEX nodes_parent ON nodes(parent_id, position);
CREATE VIRTUAL TABLE nodes_fts USING fts5(id, text_preview);
```

Derived state: a Loro subscribe handler transforms diff events → SQL upserts inside an OPFS transaction. Enables:

- Instant document outline / TOC
- FTS without walking Loro trees
- **Agent context retrieval** ("find paragraphs about X" returns LoroTreeNode IDs — fuel for the agent's `Stream` workflows in [`ai-agent.md`](ai-agent.md))
- Cross-doc workspace search (every doc's mirror in OPFS)
- Block-level reactivity for React via SQL subscriptions

Cost: ~30 LoC per node type to maintain the mirror.

### 2.3 WASM tree-sitter for code blocks [DECIDED]

`web-tree-sitter`; incremental reparsing; one parser per language. Only credible option for first-class code blocks.

### 2.4 WASM snapshot diff + per-audience redaction [DECIDED]

Loro's `export({ mode: "update", from: vector })` and `checkout(version)` give us snapshot diff / rollback / compare-to-last-hour. Redaction of restricted subdoc payloads for filtered viewers happens at WASM speed in the DO.

### 2.5 WASM crypto for capability tokens [MINOR]

Biscuit / macaroon impls; WebCrypto suffices but WASM impls have cleaner caveat semantics. See [ADR 0004](adr/0004-capability-token-format.md). Note and move on.

## 3. What WASM does NOT help with

- **DOM patching / contenteditable** — DOM is JS-bound; WASM can't touch it. The browser will not get faster.
- **React rendering** — JS engine territory. Use Effect-TS `SubscriptionRef` cells (per [ADR 0006](adr/0006-ui-state-effect-over-valtio.md)) with `Stream.changes` + microtask coalescing for fine-grained subscribe.
- **Selection mapping** — round-trip overhead > Loro gains for individual `Cursor` ↔ DOM Selection calls. Keep this in JS.

## See also

- [`architecture.md`](architecture.md) — overall system architecture
- [`hard-problems.md`](hard-problems.md) — the implementation challenges, including selection
- [`access-control.md`](access-control.md) — where Loro-WASM op decomposition powers server-side validation
- [`adr/0001-adopt-loro-over-yjs.md`](adr/0001-adopt-loro-over-yjs.md) — full Loro rationale
