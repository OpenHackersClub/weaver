# ADR 0001 — Adopt Loro as the CRDT Core (Replacing Y.js / Yrs)

- **Status:** Accepted
- **Date:** 2026-05-17
- **Supersedes:** Decision D6 noted in [`specs/prd.md` §10](../prd.md); closes the open Yrs-vs-Loro spike (D13).

## Context

weaver's defining architectural commitment is that **the CRDT is the document model — there is no parallel editor state** (see [`prd.md` §10 D1](../prd.md) and [`architecture.md` §2](../architecture.md#2-document-model--lorodoc-as-single-source-of-truth)). Every other decision (history, agent collaboration, access control, sync, undo, schema enforcement) flows through the CRDT layer. The CRDT choice is therefore the single most consequential technology decision in the project.

The initial research doc left this open. Two candidates met the bar:

1. **Y.js / Yrs.** JavaScript Y.js plus its Rust port Yrs compiled to WASM. Mature ecosystem (`y-websocket`, `y-protocols`, `y-indexeddb`, awareness protocol, Hocuspocus server, broad editor integrations).
2. **Loro.** Rust-native CRDT engine; WASM is the primary distribution. Purpose-built for rich text + structured data. Built-in version control (forks/branches), peer-scoped undo, time travel, and a richer text model with marks as first-class.

The research doc had a 1-week spike planned (D13) to settle this. Rather than burn the spike, we are taking the decision now based on architectural fit. Rationale below.

## Decision

**Adopt Loro as weaver's CRDT core**, replacing all references to Y.js / Yrs in the architecture. This decision applies to:

- The client editor core (`@weaver/core`)
- The Cloudflare Durable Object on the server (`@weaver/server`)
- The OPFS persistence layer (`@weaver/sync`)
- The agent peer runtime (`@weaver/agent`)
- All plugins authored against the document model

Y.js / Yrs is no longer a fallback. The package layout dropped from "Yrs / Loro wrapper" to a single Loro wrapper in `@weaver/wasm`.

## Why Loro Wins for This Project

### 1. Rich-text marks are a first-class CRDT primitive

In Y.js, inline formatting (`bold`, `italic`, link spans) is layered on top of `Y.Text` via a separate attribute API that has historically had subtle merge anomalies on concurrent format changes. Loro's `LoroText` exposes **marks/spans as a native CRDT type** with well-defined concurrent semantics. For an editor where format-while-typing collisions between humans and agents are routine, this is a load-bearing property — not a footnote.

### 2. Built-in time travel + version branches

Loro supports **named snapshots, branch/fork, and merge** of document branches as first-class operations. We had already planned to need this for:

- AI agent "preview before commit" workflows (research §6.5)
- Per-audience snapshot redaction (research §7.4)
- Suggestion mode as a derived branch (research §8.5)
- Disaster recovery from a poisoned doc (research §13 open question)

In Y.js, each of these is either custom plumbing on top of `encodeStateAsUpdate` / `applySnapshot` or unavailable. Loro ships them.

### 3. Peer-scoped undo is native

Y.js requires constructing a `Y.UndoManager` with origin filtering — workable but fiddly, and the "agent edits in my undo stack" problem is a recurring foot-gun. Loro's undo manager is peer-scoped by default. This aligns directly with research §2 D2 (history powered by origin tags) and §8.5 (server-authoritative origin rewrite).

### 4. Performance ceiling is materially higher

Public benchmarks and the Loro team's published numbers show:

| Workload | Yrs WASM | Loro WASM |
|---|---|---|
| Apply 100k-op update | ~120 ms | ~25–40 ms |
| Memory per op | ~32 B | ~16–24 B |
| State vector encode | ~5–15 ms | ~2–5 ms |
| Large-doc cold load | scales linearly | scales sub-linearly with snapshot |

The research doc identified Y.js's perf ceiling on ~100k+ op docs as one of the explicit costs we'd accept (§3, §6.6). Loro raises that ceiling without buying anything we lose value from.

### 5. Wire format and persistence are designed for the read-model pattern

We had committed to a **wa-sqlite + OPFS read-model mirror** (research §7.2) inspired by Zero. Loro's update format gives us:

- Stable, cheap-to-decode op kinds (insert / delete / mark / attr) that map cleanly onto our SQLite upsert pipeline.
- A documented `import_snapshot` / `import_updates_batch` API designed for offline catch-up — no need to layer our own batching.
- Snapshot format that **already includes deleted-tombstone GC**, so cold loads after long history don't pay the full tombstone cost.

Y.js can do this too but requires more glue.

### 6. Server-side op decomposition is cleaner

Loro's `Diff` API exposes ops with **already-resolved targets** (container ID + path). Yrs gives you a raw op list that you walk yourself. For any case where the server needs to inspect or classify ops at the wire layer, Loro is meaningfully easier to work with correctly.

> **Trust-model update ([ADR 0005](./0005-trust-model.md), 2026-05-17):** this advantage was framed as load-bearing when the original draft of `access-control.md` planned per-op validation as a security boundary against malicious authenticated insiders. Under the cooperative-organization trust model, per-op decomposition is **no longer load-bearing** for security. The advantage still exists — it remains useful for the periodic content-integrity sweep, for telemetry, and for any future feature that needs server-side op classification — but it is no longer part of the rationale for picking Loro. The decision remains correct on its other merits (rich-text marks as CRDT primitive, native peer-scoped undo, version control, perf, wire format).

### 7. Native subdoc-equivalent ("Loro container tree")

Subdoc partitioning (research §8.4 Primitive 3) is the load-bearing access-control pattern. Y.js's `Y.Subdoc` is a real but somewhat bolted-on type — it has quirks around lifecycle, autoload, and parent doc references. Loro's container tree (LoroDoc → containers) is a uniform hierarchy from the ground up, with sync of individual containers controllable per-peer. The pattern we want maps onto Loro's primitives without ceremony.

### 8. Rust-first ecosystem fits our server runtime

Cloudflare Workers + Durable Objects run WASM natively (`workerd`). Loro is Rust-native and ships WASM as a first-class build target with TypeScript bindings as a wrapper. Yrs is also Rust, but its TypeScript-facing API is shaped to look like Y.js (a JavaScript library) rather than a native typed API. Building on Loro from day one means the same typed API surface on both sides of the wire.

## What We Lose (and How We Mitigate)

### Ecosystem maturity

Y.js has years of community integrations: Tiptap collab, BlockNote, Hocuspocus, y-websocket servers, awareness protocol implementations in many languages, Liveblocks/Partykit support, etc.

**Mitigation:** Most of this ecosystem is not on our critical path. We are *not* building on Tiptap or ProseMirror (that was rejected in research §14). Our sync is bespoke (Durable Objects + Yrs-style decomposition for access control) — we would have written it ourselves regardless. Loro has an awareness/ephemeral-state primitive sufficient for our presence needs.

### Smaller community, fewer Stack Overflow answers

Onboarding plugin authors will be harder. They can't just copy a Tiptap-collab snippet.

**Mitigation:** Plugin authors are already required to learn Effect-TS (research D10) — they are a small, technical audience. We will invest in plugin templates and a "hello world" plugin alongside the v1 release. The cost of teaching Loro to that audience is small compared to the cost of teaching the rest of the stack.

### `y-websocket` / `y-indexeddb` cannot be reused

We can't drop in y-websocket on the server or y-indexeddb on the client.

**Mitigation:** We were not going to use either. y-indexeddb is replaced by OPFS + our wa-sqlite mirror (research §7.2). y-websocket's server is not access-control-aware enough for us — research §8 explicitly requires server-side op decomposition with Yrs/Loro in the Durable Object, which is custom code either way.

### Loro is younger; API surface less stable

Loro is younger than Y.js. Breaking changes are more likely over the next 12–24 months.

**Mitigation:** We pin a specific version, wrap Loro behind a thin Effect-TS adapter in `@weaver/wasm`, and treat Loro upgrades as ADR-worthy decisions. The adapter is ~200 LoC, not a large maintenance burden.

### Operational unknowns at scale

We do not yet have direct evidence of Loro running at e.g. tens of thousands of concurrent docs in production. Y.js has this evidence (Liveblocks, Notion-likes, various code editors).

**Mitigation:** Our scale story is per-doc-Durable-Object, which is independent of the CRDT library — the DO is the bottleneck primitive, not the CRDT. We will load-test the CRDT layer specifically as part of Phase 2 (sync) before opening to external users.

### Subtler conformance bugs are possible

Y.js is the de facto reference implementation; corner-case behavior has been hammered on by years of production use. Loro is newer; we may hit edge-case bugs (e.g. unusual mark concurrency, very deep container nesting).

**Mitigation:** We will adopt property-based testing (`fast-check`) for the document model from day one, with model-checking against a simpler reference implementation we maintain in TypeScript. This is good practice regardless of CRDT choice.

## Alternatives Considered

CoJSON is the third credible CRDT-rooted framework we considered alongside Y.js/Yrs and Loro. Here's the full table.

| Option | Why not |
|---|---|
| **Y.js (pure JS)** | Perf ceiling on large docs; op decomposition in the DO too slow for inline access-control validation; rich-text marks via attributes have known concurrent-merge anomalies. |
| **Yrs (Y.js Rust port via WASM)** | Lifts the perf and DO-side decomposition issues, but inherits Y.js's data model — including the rich-text-marks-as-attributes design and the bolted-on `Y.Subdoc` lifecycle. We'd be paying the WASM integration cost without the model-level wins of going Loro-native. |
| **CoJSON** | Rich-text today is bridged through ProseMirror with HTML conversion — a dual-state design that violates D1 ("LoroDoc is the single source of truth"). Adopting CoJSON would also mean adopting the surrounding framework (sync server, account model, ProseMirror bridge), not just a CRDT. |
| **Automerge** | Strong CRDT, excellent provenance / history model, but rich-text story is less mature than Loro's; we'd be back to layering marks on top of a text type that wasn't designed for them. |
| **Custom CRDT** | Vastly out of scope. The CRDT is hard; reusing a serious engine is non-negotiable. |
| **Operational Transform (e.g. ShareDB)** | Rejected by `prd.md` §5 non-goals — CRDT-only, no OT. |

## Consequences

### Immediate

- `specs/prd.md` and `specs/architecture.md` reflect Loro end-to-end; D13 closed (this ADR is the resolution).
- `README.md` updated: stack section reflects Loro.
- Phase 0 spike (research §12) no longer needs to settle Yrs vs Loro; the spike becomes a Loro-specific feasibility prototype (selection model + DO sync skeleton).

### Downstream

- All future ADRs and plugin docs target Loro as the document model.
- The thin Effect-TS adapter in `@weaver/wasm` becomes the **only** module that imports Loro directly. App code imports from `@weaver/core`'s typed wrappers.
- Property-based tests against the Loro-backed document model are a Phase 0 deliverable, not a nice-to-have.

### Reversibility

This decision is **expensive but not impossible to reverse**, *if* it is reverted before significant plugin code exists. The reversal cost grows roughly linearly with the number of plugins and the size of the audit log (because the audit log embeds CRDT-update binaries).

We commit to revisiting this ADR if any of the following are observed during Phase 0 or Phase 1:

- Loro hits a correctness bug we cannot work around in the rich-text-marks model within two weeks of triage.
- Loro's WASM bundle size exceeds 800 KB gzipped at the version we depend on (current is well below this).
- Loro's per-doc memory footprint exceeds 2× Yrs on representative workloads in our benchmark suite (we expect Loro to be lower, but will measure).
- Loro abandons rich text as a focus area, or the project stops receiving meaningful updates for 6+ months.

A reversal would itself be a new ADR superseding this one.

## References

- Loro — <https://loro.dev>
- Loro GitHub — <https://github.com/loro-dev/loro>
- Loro rich-text design — <https://loro.dev/docs/tutorial/text>
- Loro version control — <https://loro.dev/docs/tutorial/version_deep_dive>
- Yrs (for the alternative considered) — <https://github.com/y-crdt/y-crdt>
- Y.js text formatting issues (motivating §1 above) — Y.js GitHub issue tracker, search "concurrent formatting"
- weaver product brief — [`specs/prd.md`](../prd.md)
- weaver architecture — [`specs/architecture.md`](../architecture.md)
