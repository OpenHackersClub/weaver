# ADR 0002 — Notion-Style Block Model

- **Status:** Accepted
- **Date:** 2026-05-17
- **Relates to:** Decision D1, [`architecture.md` §2, §5](../architecture.md); [`comparison.md`](../comparison.md)

## Context

The initial research treated weaver as a generic "rich-text editor with a CRDT document model." That left the document-model UX open: flat prose, schema-strict tree, or block-based. The choice shapes every plugin, every block schema, every UI affordance, and the surface area the AI agent operates on.

## Decision

**weaver is a Notion-style block editor.** The block is the unit of editing, selection, attribution, comments, drag/move, AI-rewrite, and ACL tagging. The block schema is a first-class primitive in `@weaver/core` and maps directly onto Loro container types.

Scope is **docs only**: typed blocks, nested blocks, block-level operations, slash-command insert, drag handle, per-block metadata, per-block ACL tags, rich inline content (marks, links, mentions) inside text-bearing blocks. Whiteboard / freeform canvas, Database block, and multi-view collection surfaces are not part of v1 — they're separate products and live behind the `embed` block when needed. Rationale and reversibility are in §"Scope boundary" below.

## How blocks work

### Every block has

- **A stable ID** — the underlying `LoroTreeNode` ID. Persists across moves, edits, and re-parenting.
- **A typed `kind`** — `paragraph`, `heading`, `list-item`, `code`, `quote`, `callout`, `divider`, `image`, `embed`, `mention`, plus plugin-registered kinds.
- **Typed attributes** validated by Effect Schema (per-kind shape). Schema is registered with the block-kind plugin; the editor refuses to apply ops that violate it on the client.
- **An optional inline content container** — `LoroText` for text-bearing kinds; absent for atomic blocks like `divider` or `image`.
- **Children** — recursive, via `LoroTree` parent/child edges. Lists, toggles, callouts, table rows all nest this way.

### Mapping to Loro containers

| Editor concept | Loro container | Notes |
|---|---|---|
| Document root | `LoroDoc` | One per logical doc; subdocs partition tiers per [`access-control.md` §5](../access-control.md). |
| Block tree | `LoroTree` at path `content` | Each tree node is one block; structure ops (move, indent, outdent) are tree ops. |
| Block `kind` and attrs | `LoroMap` on the tree node | `{ kind: "callout", icon: "💡", tone: "info" }`. |
| Inline content | `LoroText` on the tree node | Only for text-bearing kinds. Marks live as Loro `mark/unmark` ops on this text. |
| Block-level ACL tag | `subdoc: string` attr on the tree node | Read by the sync layer to route into the right subdoc. |

This layout means structural operations (insert, delete, move, indent, outdent) are native `LoroTree` ops with their CRDT semantics defined by Loro — not editor-layer transforms that have to be reconciled across peers.

### Block-level operations (core, not plugin-supplied)

| Command | What it does | CRDT primitive |
|---|---|---|
| `block.insert(parentId, index, kind, attrs)` | Create a new block of `kind` under `parentId` at `index`. | `tree.create` + `map.set` |
| `block.transform(blockId, newKind, attrs)` | Change a block's kind in place (e.g. paragraph → heading). Preserves children and inline content when compatible. | `map.set` on the node |
| `block.move(blockId, newParentId, newIndex)` | Move within or across parents. | `tree.move` |
| `block.indent(blockId)` / `block.outdent(blockId)` | Sugar over `tree.move` against siblings. | `tree.move` |
| `block.delete(blockId)` | Tombstone the node; children follow. | `tree.delete` |
| `block.split(blockId, offset)` | Split a text-bearing block at `offset` into two siblings of the same kind. | `text.delete` on tail of A + `tree.create` of B + `text.insert` |
| `block.merge(prevId, nextId)` | Inverse of split; append `next`'s text into `prev`, delete `next`. | `text.insert` + `tree.delete` |

These are the **only** structural commands plugins compose against. Plugins don't reach into `LoroTree` directly — they call these.

### How plugins extend blocks

A plugin registers one or more **block kinds** and/or **marks**. A block-kind registration declares:

- The `kind` string (must be globally unique; namespaced for non-core plugins: `myorg.timeline-event`).
- The Effect Schema for its typed attrs.
- Whether children are allowed; if so, which kinds are allowed as children.
- Whether inline content is allowed (and which marks are valid inside it).
- A `concurrentSemantics` declaration per [ADR 0003](./0003-concurrent-semantics-no-global-rw-aw.md) — what to do when two peers concurrently edit the same block.
- A render adapter (currently React; the renderer is an interface so a non-React adapter can ship later — see [`architecture.md` §3](../architecture.md#3-rendering-layer)).
- Optional commands the plugin contributes (e.g. `code.toggleLineNumbers`).

Plugins **cannot** register top-level surface modes — no plugin can ship a whiteboard or a Database view inside weaver v1. They extend the block kind catalog; they don't change the editor's modality.

### Why blocks are the right unit for the AI agent

The agent (see [`ai-agent.md`](../ai-agent.md)) operates on stable, addressable units. A block:

- Has an ID the agent can reference across turns (`block:01H7…`) without worrying about cursor drift.
- Has a typed `kind` the agent can reason about ("this is a heading; suggest sub-blocks").
- Maps cleanly to the agent's tool surface: `rewrite-block(blockId, instruction)`, `transform-block(blockId, newKind)`, `generate-children(blockId, prompt)`.
- Carries its own ACL tag, so the capability check at the tool boundary is one lookup against `block.subdoc`.

Block-level concurrent semantics (ADR 0003) mean the agent and a human can edit the same block without coordinating — Loro merges, and `origin: agent-N` survives into the audit log.

## Block kinds shipped in v1

| Kind | Children allowed | Inline content | Notes |
|---|---|---|---|
| `paragraph` | No | Yes | Default block; markdown shortcut to other kinds. |
| `heading` | No | Yes | Levels 1–3 (1–6 supported in schema; UI defaults to 3). |
| `bullet-list-item` | Yes (recursive list items) | Yes | Nesting → indent depth in UI. |
| `numbered-list-item` | Yes | Yes | Auto-renumber on reorder. |
| `to-do` | Yes | Yes | `checked: boolean` attr. |
| `toggle` | Yes | Yes | `collapsed: boolean` ephemeral state per-viewer. |
| `quote` | Yes | Yes | Single-level only. |
| `callout` | Yes | Yes | `icon: emoji`, `tone: info\|warn\|danger\|note`. |
| `code` | No | Yes (plain) | `language: string`; tree-sitter highlighting. |
| `image` | No | No | `src`, `alt`, `width`, `height`; OPFS cache + R2. |
| `embed` | No | No | `url`, with allowlisted providers; iframe sandbox. |
| `mention` | No | n/a (inline) | Inline kind; references a subject (user/agent). |
| `divider` | No | No | Atomic. |
| `table` | Yes (`table-row` → `table-cell`) | No (cells have inline) | Block-table (not a Database); fixed columns. |

Plugins can register additional block kinds. They cannot remove these built-ins (would break content portability).

## Marks shipped in v1

| Mark | Constraints |
|---|---|
| `bold`, `italic`, `underline`, `strike` | Free overlap. |
| `code` | Inline code; cannot overlap `link`. |
| `link` | `href`; cannot overlap `code`; cannot nest. |
| `highlight` | `color: enum`. |
| `comment-anchor` | Internal; anchors a comment thread; not exposed to formatting UI. |
| `agent-pending` | Internal; "uncommitted agent edit" visualization. |

Plugins can register additional marks with constraint declarations enforced at op-validation time.

## Scope boundary (what's not in v1)

Whiteboard / freeform canvas and Database block (multi-view tables) are explicitly out of v1. Both are separate problem shapes:

- **Whiteboard** is 2D-positioned, layered, transform-heavy. Its selection model is rectangle-based, not block-based. Per-block ACL ([`access-control.md` §5](../access-control.md)) doesn't map onto overlapping rectangles on an infinite canvas. A future canvas surface, if we build one, would live in its own product, not as a mode toggle inside weaver.
- **Database block** is a collection of typed entities with multiple views (Table, Kanban, Calendar, Gallery) and query semantics (filter, sort, group, formula). Its CRDT shape (per-cell LWW, ordered rows with insertion semantics, schema migrations on typed columns) is its own design problem and not addressed by the block tree.

For both, the v1 answer is the `embed` block — an iframe sandbox pointing at an external whiteboard or table. A future `query-embed` block kind can render a live external collection inline without making weaver own the collection.

## Consequences

### Immediate

- `architecture.md` §2 (document model) specifies the Notion-style block layout.
- `architecture.md` §5 (plugin architecture): plugins register block kinds and marks against a typed schema.
- `comparison.md`: positioning is "Notion-style block editor, scoped to docs only."

### Downstream

- Every plugin authored as a block-kind plugin or a mark plugin (or both).
- Block-level commands (`block.insert`, `block.transform`, `block.move`, `block.indent`, `block.outdent`, `block.delete`, `block.split`, `block.merge`) are core, not plugin-supplied.
- Slash command and drag handle are core UI affordances in `@weaver/react`.
- AI tools have a natural unit ("rewrite block", "summarize block", "transform-kind block to callout"); the agent tool registry exposes block as a first-class addressable resource.
- Block-level ACL tags tie directly to `LoroTreeNode` attrs — no extra modeling needed.

### Reversibility

- Adding whiteboard or Database scope later is *technically* possible but **culturally hard** once we've shipped a focused product. Customers anchor on "this is the doc-only editor." Treat the next-scope addition as a separate product (`weaver-board`, `weaver-tables`), not a v2 of this one.
- Removing block kinds is a breaking content change. Once `callout` ships, it's permanent.

### Risks

- Users will ask for tables-as-database. The answer is "use the `query-embed` plugin to embed an external table" once that plugin exists.

## References

- [Notion's block model](https://www.notion.so/help/what-are-blocks)
- ADR 0001 — Loro adoption — [`./0001-adopt-loro-over-yjs.md`](./0001-adopt-loro-over-yjs.md)
- ADR 0003 — Concurrent semantics — [`./0003-concurrent-semantics-no-global-rw-aw.md`](./0003-concurrent-semantics-no-global-rw-aw.md)
