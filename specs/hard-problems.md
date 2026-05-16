# weaver — Hard Problems

> The things that are genuinely hard. Listed roughly in implementation-order priority. Companion to [`architecture.md`](architecture.md); product context in [`prd.md`](prd.md).

## 1. Selection on a CRDT — **design this first**

Loro's `Cursor` anchors a position to a CRDT location and survives concurrent edits. The work is:

- Mapping `Cursor` ↔ DOM `Selection` cleanly across concurrent inserts/deletes.
- Handling browser quirks: IME composition, contenteditable selection drift, double-click word boundaries.
- Multi-cursor (collab + agent) overlays without fighting the native caret.
- Selection on collapsed ranges, on inline-void nodes (e.g. images), across block boundaries.

This is a 4–6 week task on its own and is the highest-risk item in the project. No library will save us here. Every other implementation problem depends on selection being solved first.

## 2. Schema enforcement on a loose container model

`LoroTree` / `LoroMap` will accept any structure. The validator layer must:

- Run at the boundary of every typed mutator (no raw Loro container access from app code).
- Detect drift introduced by remote peers (e.g. a misbehaving client) and either repair (transactional fix-up) or quarantine (move into a `__quarantine` sibling tree).
- Run server-side in the DO for op validation (see [`access-control.md` §6](access-control.md)).

Effect Schema is the validator. The same schemas run on client and server.

## 3. Event-to-render coalescing

Even with Loro's per-commit batching, multiple commits in a tick are common (agent stream + user typing). Use a microtask-batched dispatcher with structural change detection downstream of `doc.subscribe()`.

Naïve hookup of `subscribe` → React `setState` will fire dozens of renders per second under streaming. Coalesce.

## 4. Lexical / BlockSuite feature parity is multi-year

`document.execCommand` is deprecated and unusable. Everything around clipboard, IME, drag-drop, undo-key handling, accessibility tree, list nesting, table editing — built from scratch.

Pick the 70–80% subset (see [`prd.md` §7](prd.md)); defer the rest to plugins / later.

This is **a lot of unglamorous work** and is where editors silently break for years. Budget for it.

## 5. AI agent "thinking" without doc pollution

Three options considered:

1. **Loro fork branch** — agent writes to a forked LoroDoc; user previews and merges. Loses the "see it stream" feel. Loro's `fork()` makes this cheap.
2. **Tagged origin + visible marker** — edits go into the main doc with `origin: agent-N` (carried natively in Loro change metadata), rendered with an "uncommitted" decoration; commit is explicit. Streaming visible. **[CHOSEN]**
3. **Speculative overlay** — agent writes are real ops but rendered with reduced opacity; commit removes the tag.

**Decision:** option 2 — keep doc as truth, origin tag carries intent. Plays well with Loro's peer-scoped `UndoManager` (agent edits don't pollute user's local undo stack). See [`ai-agent.md`](ai-agent.md) for the full streaming UX.

## 6. CRDT performance ceiling

Loro raises the ceiling materially over Y.js / Yrs ([ADR 0001](adr/0001-adopt-loro-over-yjs.md) §4). The remaining concern is large-doc cold load — addressed by snapshot-with-GC export rather than full op-log replay.

Phase 0 must benchmark cold load on representative docs.

## 7. Concurrent-operation semantics — no global RW / AW

The CRDT-research framings (Add-Wins set, Remove-Wins set, LWW map) don't map cleanly onto an editor's mix of trees, text, marks, and maps. **We do not pick a global Remove-Wins or Add-Wins framework.** Instead, semantics are documented per scenario, with a **Resolution-Visibility** rule for delete-vs-edit (preserve conflicts as a user-actionable artifact rather than silently picking a winner).

Full treatment in [ADR 0003](adr/0003-concurrent-semantics-no-global-rw-aw.md), including the graveyard pattern for block-level delete-vs-edit.

Plugin authors must declare concurrent semantics for any new op kind as part of the plugin contract ([`architecture.md` §5](architecture.md#5-plugin-architecture)).

## 8. Marks-as-CRDT correctness under load

Loro's mark primitive is newer than the rest of Loro. No reference editor on Loro exists (as of 2026-05). We must property-test concurrent mark operations (overlap, nested, undo) heavily in Phase 0, and treat any mark-related correctness bugs as ADR-revisit triggers ([ADR 0001 reversibility](adr/0001-adopt-loro-over-yjs.md)).

The closest prior art is [`loro-prosemirror`](https://github.com/loro-dev/loro-prosemirror) — the way it maps ProseMirror's schema and decoration model onto Loro containers is the most concrete reference. We don't adopt the dual-state design but we can crib from how they handle marks.

## 9. Programmatic-write collisions (AI, importer, file-watch)

A naïve "AI rewrite this paragraph" implementation does delete-then-insert on the affected range. **This destroys user cursors and any concurrent edits in the range** — a known CRDT anti-pattern (marimo's Loro PR hits this).

**Rule for weaver (mandated):** every programmatic write must produce **minimal diffs** against the current state — never bulk delete-then-insert. The agent runtime, importer, and any future file-watch importer must respect this. Property tests in Phase 3 cover this explicitly.

## 10. Cross-tier reference integrity under subdoc partitioning

A `public` block can carry a reference to a `confidential` block. When the viewer can't load the confidential subdoc, the editor renders a placeholder. When the confidential block is moved, renamed, or deleted, the placeholder must update without leaking the new state.

See [`access-control.md` §5 "Cross-tier references"](access-control.md) for the protocol. The container-ID-as-handle approach is the default; opaque-hash placeholders are an option for high-paranoia layouts.

## 11. Disaster recovery from a corrupted LoroDoc

CRDTs are append-only; a poisoned doc propagates. Recovery path:

1. Pause writes via a `read-only-emergency` flag in DO state.
2. Identify the bad update from audit log (op hashes).
3. `LoroDoc.checkout(lastGoodVersion)` to roll back.
4. Export a snapshot at that version; create a new LoroDoc from snapshot.
5. Replay good updates after the bad one (excluding the bad op).
6. Force all connected clients to reload from the new snapshot.
7. Audit-log the rollback with operator subject.

Destructive of any concurrent work between the bad op and the rollback; this is an emergency procedure, runbook must be written before Phase 2.

## See also

- [`prd.md`](prd.md) — product vision
- [`architecture.md`](architecture.md) — system architecture
- [`ai-agent.md`](ai-agent.md) — agent design (relevant to §5 and §9)
- [`access-control.md`](access-control.md) — relevant to §2, §10, §11
- [`adr/0003-concurrent-semantics-no-global-rw-aw.md`](adr/0003-concurrent-semantics-no-global-rw-aw.md) — full concurrent-semantics spec
