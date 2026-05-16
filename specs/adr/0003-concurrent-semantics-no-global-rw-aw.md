# ADR 0003 — Concurrent-Operation Semantics: Per-Scenario, Not a Global Remove-Wins / Add-Wins Framework

- **Status:** Accepted
- **Date:** 2026-05-17
- **Relates to:** [`architecture.md` §2](../architecture.md); [`hard-problems.md`](../hard-problems.md); [`access-control.md`](../access-control.md); ADR 0001 (Loro), ADR 0002 (block model)

## Context

CRDT design literature distinguishes two canonical conflict-resolution frameworks for concurrent add/remove operations:

- **Add-Wins (AW)** — e.g. **OR-Set** (Observed-Remove Set): when one peer adds an element and another concurrently removes it, the element survives. The "add" wins. Most production CRDT libraries default to AW for sets/maps because it matches user intuition ("I added this — why did it disappear?").
- **Remove-Wins (RW)** — e.g. **2P-Set**: concurrent add+remove → element is removed. Sometimes safer for compliance (deletion is final), but loses information and surprises users ("I clearly added this and it vanished").

The question for weaver: **do we adopt a global Remove-Wins (or Add-Wins) framework for our document model?**

This ADR documents why the answer is **no**, and what we do instead.

## Decision

**weaver does not adopt a global Remove-Wins or Add-Wins framework.** Instead:

1. Each Loro container type has well-defined concurrent semantics. We **defer to those** wherever they're sufficient.
2. Where Loro's semantics are insufficient or surprising for an editor UX, we **document an editor-level rule per scenario** and enforce it in the op-validation layer or the rendering layer.
3. The rule of thumb when we *do* have a choice: **prefer Add-Wins for content**, **prefer Last-Writer-Wins for attributes**, and **handle delete-vs-edit explicitly via a graveyard pattern** (see "Block-level delete-vs-edit" below).

There is no master switch. There is a documented behavior per scenario.

## Why no global RW/AW

1. **Rich-text editors don't have one "set of elements."** They have a block tree, inline text streams per block, formatting marks, attribute maps, comments, suggestions, and cross-tier references. Each has different desired semantics; a global setting is too coarse.
2. **Loro already commits to specific algorithms** (Fugue for text, RGA-like for movable list, LWW for map, movable-tree CRDT for tree). Overriding these would require either forking Loro or layering an inefficient AW/RW filter on top — neither is a real option.
3. **AW vs RW are framings that map cleanly onto sets and maps**, less cleanly onto positional text and trees. The honest answer for an editor is per-container, not per-framework.
4. **User intuition is operation-specific.** "Don't lose my typing" (favor preserving edits) and "Don't resurrect content I deliberately deleted" (favor deletion) are both legitimate user expectations in different contexts.

## Per-scenario semantics

### 1. Concurrent text insert + insert (same position)

- **Container:** `LoroText` (Fugue).
- **Behavior:** Both inserts land; Fugue produces a deterministic interleaving that minimizes interleaving anomalies. No conflict.
- **UX implication:** Neither edit is lost. This is the default desired behavior.

### 2. Concurrent text insert + delete (overlapping range)

- **Container:** `LoroText`.
- **Behavior:** Inserts that target positions deleted by the concurrent delete still land (anchored to surviving neighbors).
- **UX implication:** A peer who keeps typing into a range another peer deleted doesn't lose their typing — it lands adjacent to the deletion. Slight surprise but standard CRDT behavior.

### 3. Concurrent mark add + mark remove (same range, same key)

- **Container:** `LoroText` marks (Loro's rich-text mark CRDT).
- **Behavior:** Loro's documented mark semantics apply. **For the marks we ship (§"Marks" in ADR 0002), all are commutative-add-overrides** — concurrent add + remove on the same range → mark stays. This is **effectively Add-Wins** at the mark level.
- **UX implication:** "I bolded this; you concurrently unbolded; it stays bold." Documented; surfaced in tooltip help.
- **Override:** A user can deliberately remove a mark after seeing the concurrent state by issuing a fresh remove. The CRDT does not retroactively re-process the resolved state.

### 4. Concurrent mark add (different ranges) + mark add (overlapping range)

- **Behavior:** Marks compose; overlapping ranges merge into a single mark range with the union of operations.
- **UX implication:** Expected; no user-visible conflict.

### 5. Concurrent block-tree move + delete (movable tree CRDT)

- **Container:** `LoroTree`.
- **Behavior:** Loro's movable-tree CRDT prevents cycles and resolves move-vs-delete deterministically. Per Loro's semantics, if peer A moves block B under block X while peer B deletes block X concurrently, the move is resolved against the surviving tree state — typically the block reverts to its previous parent (or a sentinel "orphan" root).
- **UX implication:** The moved block doesn't end up parented to a non-existent block. The "where did it go?" surprise is mitigated by surfacing orphaned blocks in a UI lane (see "Graveyard pattern" below).

### 6. Block-level delete-vs-edit — **the editor-level rule**

This is the most user-visible scenario and Loro's defaults aren't fully sufficient.

**Scenario:** Peer A deletes block B; peer B (the human or an agent) concurrently edits block B's text.

**Default Loro behavior:** the deletion of the tree node wins (block is gone); the text inserts into the tree node still exist in the tree-node container's history but are unreachable from the live tree.

**Problem:** the edits are silently lost to the active doc. For an AI agent streaming generation into a block that the user deleted mid-stream, this is a real footgun.

**Editor-level rule (weaver's choice):**

1. On every commit, the validator detects deletes of blocks that had concurrent text inserts arriving after the delete's logical time.
2. Such blocks are **moved to a `graveyard` sibling tree** in the same subdoc, with metadata: original parent, original position, deleting subject, time of conflict.
3. The graveyard is **not deleted automatically**. Items linger for a configurable TTL (default 24 hours) before hard-delete.
4. The deleter is notified ("you deleted a block someone else was editing — it's in the graveyard"). The active editor is notified ("your edits to this block landed in the graveyard").
5. UI offers "restore from graveyard."

This is **not Remove-Wins and not Add-Wins** — it's a third option: **Resolution-Visibility**. The conflict is preserved as a first-class artifact the user can act on.

### 7. LoroMap key write + concurrent write (same key)

- **Container:** `LoroMap`.
- **Behavior:** Last-Writer-Wins by logical clock.
- **UX implication:** Block attributes (`heading.level`, `list-item.checked`, `image.alt`) follow LWW. Fine for the vast majority of attribute changes; users don't generally race on attributes the way they race on text.
- **Override:** None. Where we genuinely need merge semantics on an attribute (rare), model it as a `LoroText` field or a `LoroList` and use the appropriate semantics.

### 8. Concurrent ACL-tag change on a block

- **Container:** `LoroMap` attribute on the block (`acl-tag`).
- **Behavior:** LWW by default. **But** we add a server-side rule: only `admin`-scope subjects can change `acl-tag`; concurrent admin changes resolve via LWW; concurrent non-admin changes are rejected at op-validation time.
- **UX implication:** ACL changes are deliberate, infrequent, and gated. The CRDT semantics matter less than the access-control gate.

### 9. Concurrent suggestion merge + main-doc edit

- **Containers:** Suggestion fork (LoroDoc) vs. main subdoc (LoroDoc).
- **Behavior:** Loro's CRDT merge — concurrent edits in the main while the suggestion was open are preserved; the suggestion's edits land on top.
- **UX implication:** If the main has moved meaningfully under the suggestion, the merged result may not be what the acceptor expects. UI surfaces a diff preview at accept time; acceptor can decline or hand-merge.

### 10. Concurrent comment add + comment-anchor range deletion

- **Containers:** `comments` tree (separate from main content) anchored via `Cursor` into main content.
- **Behavior:** Comment row persists; cursor anchor may become orphaned if the entire anchored range is deleted.
- **UX implication:** Orphaned comments don't vanish — they appear in a side panel marked "anchor lost." User can re-anchor or archive.

## Mental model for weaver contributors

When designing a new block kind, mark, or attribute, run through this checklist:

1. Which Loro container does it live in?
2. What's Loro's documented concurrent behavior for that container?
3. Is that behavior surprising for the editor UX?
   - **If no:** done — defer to Loro.
   - **If yes:** define an editor-level rule, enforce it in op-validation, document it in the plugin spec.
4. Does the rule match the **Resolution-Visibility** pattern (preserve conflicts as user-visible artifacts) rather than silently picking a winner? Prefer Resolution-Visibility for content-bearing scenarios.

## What this is not

- **Not a claim that Loro is buggy.** Loro's semantics are well-defined and correct. We're choosing where to layer editor-specific rules on top.
- **Not an excuse to ad-hoc semantics per plugin.** Plugin authors must explicitly document concurrent behavior for any new operation. The plugin contract requires it.
- **Not a substitute for property tests.** All claims here must be backed by `fast-check` property tests against the document model (see [`access-control.md`](../access-control.md) §17).

## Consequences

### Immediate

- `architecture.md` §2 (document model) and `hard-problems.md` §7 reference this ADR for concurrent semantics.
- The `Plugin` type in §10 gains a `concurrentSemantics` field (per-op-kind) that plugin authors must populate.
- A `graveyard` sibling tree is added to every subdoc; the op-validator routes orphaned content to it.

### Downstream

- Block-delete UI shows a "see graveyard" affordance when items have been moved there in the last TTL.
- Graveyard restore is a privileged action (write scope on the parent subdoc).
- Property tests in Phase 0 must cover scenarios 1–10 above.

### Trade-offs

- **Cost:** more complexity per plugin spec; more rules to document and test.
- **Benefit:** users never silently lose content to a CRDT conflict. The Resolution-Visibility pattern gives them an artifact to act on.

## References

- [Loro CRDT algorithms](https://deepwiki.com/loro-dev/loro/6.1-crdt-algorithms)
- [Loro movable tree CRDT (HN discussion)](https://news.ycombinator.com/item?id=41099901)
- [OR-Set (Observed-Remove Set) — Shapiro et al.](https://hal.inria.fr/inria-00555588)
- [Fugue: minimizing interleaving anomalies in collaborative text editing](https://arxiv.org/abs/2305.00583)
- ADR 0001 — Loro adoption
- ADR 0002 — block model
