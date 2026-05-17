# ADR 0002 — Notion-Style Block Model

- **Status:** Accepted
- **Date:** 2026-05-17
- **Relates to:** Decision D1, [`architecture.md` §2, §5](../architecture.md); [`block-model.md`](../block-model.md); [`comparison.md`](../comparison.md)

## Context

The initial research treated weaver as a generic "rich-text editor with a CRDT document model." That left the document-model UX open: flat prose, schema-strict tree, or block-based. The choice shapes every plugin, every block schema, every UI affordance, and the surface area the AI agent operates on.

## Decision

**weaver is a Notion-style block editor.** The block is the unit of editing, selection, attribution, comments, drag/move, AI-rewrite, and ACL tagging. The block schema is a first-class primitive in `@weaver/core` and maps directly onto Loro container types.

Scope is **docs only**: typed blocks, nested blocks, block-level operations, slash-command insert, drag handle, per-block metadata, per-block ACL tags, rich inline content (marks, links, mentions) inside text-bearing blocks. Whiteboard / freeform canvas, Database block, and multi-view collection surfaces are not part of v1 — they're separate products and live behind the `embed` block when needed. Rationale and reversibility are in §"Scope boundary" below.

The block data structure, its mapping to Loro containers, the block-level command surface, and how plugins extend block kinds are all specified in [`block-model.md`](../block-model.md). This ADR records the *decision*; the spec records the *design*.

## Why Notion-style blocks specifically

The block-as-unit model is the right primitive for weaver because:

- **One unit, many affordances.** A block is the unit of editing, selection, attribution, comments, drag/move, AI-rewrite, and ACL tagging. Folding all of those onto one addressable object means plugin authors think in "block kinds," not in a tree-node mix of block / inline / mark types.
- **Cleanly maps to Loro.** Each block is a `LoroTreeNode` with a `LoroMap` of typed attrs and (optionally) a `LoroText` for inline content. Structural ops (move, indent, outdent) are native `LoroTree` ops with CRDT semantics defined by Loro — not editor-layer transforms that have to be reconciled across peers.
- **Natural addressable unit for the AI agent.** The agent operates on `block:01H7…` IDs across turns; tools have a stable, typed referent (`rewrite-block`, `transform-block`, `generate-children`). The agent's view of the doc is the block tree, the same primitive a human collaborator uses.
- **Stable handle for per-block ACL.** A `subdoc: string` attr on each block routes it to the right tier-partitioned LoroDoc at sync time ([`access-control.md` §5](../access-control.md)). No extra modeling layer.

Alternatives considered:

| Alternative | Why not |
|---|---|
| **Flat prose** (e.g. Delta) | No structural block addressable. Lists, code blocks, and callouts are either lost or smuggled in as embedded HTML. Per-block operations (drag handle, ACL tag, comments anchored to a block, AI tools targeting a block) have no natural anchor. |
| **Schema-strict tree without an explicit "block" concept** | Tree nodes are mixed-grain — block-like nodes, inline nodes, and marks share the same type universe. Plugin and AI-tool authors must reason about node grain on every operation. Block-level affordances become editor-wide concerns to retrofit. |
| **Notion-style blocks** (this decision) | Each block is a uniform first-class addressable thing. See bullets above. |

## Scope boundary (what's not in v1)

Whiteboard / freeform canvas and Database block (multi-view tables) are explicitly out of v1. Both are separate problem shapes:

- **Whiteboard** is 2D-positioned, layered, transform-heavy. Its selection model is rectangle-based, not block-based. Per-block ACL ([`access-control.md` §5](../access-control.md)) doesn't map onto overlapping rectangles on an infinite canvas. A future canvas surface, if we build one, would live in its own product, not as a mode toggle inside weaver.
- **Database block** is a collection of typed entities with multiple views (Table, Kanban, Calendar, Gallery) and query semantics (filter, sort, group, formula). Its CRDT shape (per-cell LWW, ordered rows with insertion semantics, schema migrations on typed columns) is its own design problem and not addressed by the block tree.

For both, the v1 answer is the `embed` block — an iframe sandbox pointing at an external whiteboard or table. A future `query-embed` block kind can render a live external collection inline without making weaver own the collection.

## Consequences

### Immediate

- `architecture.md` §2 (document model) specifies the Notion-style block layout at a high level.
- `block-model.md` is the implementation spec: anatomy, container mapping, command surface, plugin extension, reactivity, Valtio role.
- `architecture.md` §5 (plugin architecture): plugins register block kinds and marks against a typed schema.
- `comparison.md`: positioning is "Notion-style block editor, scoped to docs only."

### Downstream

- Every plugin authored as a block-kind plugin or a mark plugin (or both).
- Block-level commands are core, not plugin-supplied; full list in [`block-model.md` §3](../block-model.md).
- Slash command and drag handle are core UI affordances in `@weaver/react`.
- AI tools have a natural unit; the agent tool registry exposes block as a first-class addressable resource.
- Block-level ACL tags tie directly to `LoroTreeNode` attrs — no extra modeling needed.

### Reversibility

- Adding whiteboard or Database scope later is *technically* possible but **culturally hard** once we've shipped a focused product. Customers anchor on "this is the doc-only editor." Treat the next-scope addition as a separate product (`weaver-board`, `weaver-tables`), not a v2 of this one.
- Removing block kinds is a breaking content change. Once `callout` ships, it's permanent.

### Risks

- Users will ask for tables-as-database. The answer is "use the `query-embed` plugin to embed an external table" once that plugin exists.

## References

- [`block-model.md`](../block-model.md) — implementation spec for the data structure, reactivity, and UI state.
- [Notion's block model](https://www.notion.so/help/what-are-blocks)
- ADR 0001 — Loro adoption — [`./0001-adopt-loro-over-yjs.md`](./0001-adopt-loro-over-yjs.md)
- ADR 0003 — Concurrent semantics — [`./0003-concurrent-semantics-no-global-rw-aw.md`](./0003-concurrent-semantics-no-global-rw-aw.md)
