# weaver vs. Other Rich-Text Editors

> Status: opinionated comparison. The goal is to be useful to a reader picking an editor, not to win a fight. Where weaver is weaker, we say so.

## TL;DR

| Editor | Doc model | Block-based | CRDT collab | AI as 1st-class | Local-first | Headless | License |
|---|---|---|---|---|---|---|---|
| **weaver** | LoroDoc (CRDT-native) | **Yes — Notion-style** (no whiteboard, no DB) | **Native** (Loro) | **Yes — peer model** | **Yes** (OPFS) | **Yes** | OSS (planned) |
| [Lexical](https://lexical.dev) | EditorState (tree, immutable) | Loose (nodes can be block-like) | Plugin (y-lexical) | No | No | Yes | MIT |
| [ProseMirror](https://prosemirror.net) | Strict schema tree | No (mixed-grain nodes) | Plugin (y-prosemirror) | No | No | Yes | MIT |
| [Tiptap](https://tiptap.dev) | ProseMirror | Sort of (extensions for block-ish UX) | Plugin (Hocuspocus / Tiptap Cloud) | Pro tier | No | Yes | MIT (core) / commercial |
| [Slate](https://docs.slatejs.org) | React-managed tree | Loose | Plugin (slate-yjs) | No | No | Yes | MIT |
| [BlockNote](https://www.blocknotejs.org) | Tiptap blocks | **Yes — Notion-style** | Yes (Yjs) | Limited | No | Partial | MPL-2.0 |
| [BlockSuite](https://blocksuite.io) / [AFFiNE](https://affine.pro) | Y.js → migrating to **Loro** | **Yes — multi-modal** (page + whiteboard + DB) | Native (Yjs/Loro) | Some | Yes | Yes | MPL-2.0 |
| [Editor.js](https://editorjs.io) | JSON blocks | **Yes — blocks** | None | No | No | Yes | Apache-2.0 |
| [Quill 2.0](https://quilljs.com) | Delta ops | No (inline-flat) | Plugin (loro-quill / others) | No | No | Yes | BSD-3 |
| [CKEditor 5](https://ckeditor.com/ckeditor-5/) | Custom model | Loose (block-ish via plugins) | **Native** (proprietary OT) | Add-on | No | Partial | GPL/commercial |
| [Milkdown](https://milkdown.dev) | ProseMirror, markdown-first | No | Plugin (y-prosemirror) | No | No | Yes | MIT |
| [CodeMirror 6](https://codemirror.net) | Code, not prose | n/a | Plugin (y-codemirror.next) | No | No | Yes | MIT |

(See "Honest caveats" at the bottom — some columns are simplifications.)

---

## What weaver optimizes for (so the comparison makes sense)

1. **Notion-style block model — focused on docs.** Every block is a typed, addressable unit; nested blocks, slash-command, drag handle. **No whiteboard, no Database block** ([ADR 0002](adr/0002-notion-style-block-model.md)) — the explicit scope is "blocks for prose, scoped to docs."
2. **AI agents as first-class CRDT peers**, not a side-channel chat panel. Token streams become CRDT ops; multi-agent and human↔agent concurrency is free.
3. **Loro as the single source of truth.** No parallel editor state to sync (the Lexical+Y.js bolt-on problem we explicitly reject).
4. **Local-first on Cloudflare.** OPFS persistence; Durable Object per doc; server-enforced access control via subdoc partitioning + op validation.
5. **Effect-TS plugin contract.** Typed, layered, exhaustive — heavier learning curve than callback-based plugin APIs, but better correctness guarantees.
6. **Headless by construction.** Core has no React/DOM dependency.

If those aren't on your top-5 list, several of the editors below will likely serve you better.

---

## Editor-by-editor

### Lexical (Meta)

Lexical is the editor weaver aims to replace. It's a modern, TypeScript-first editor with an immutable `EditorState` tree, a clean plugin model, and a headless React story. It powers Facebook's surfaces.

**Strengths:** Excellent React DX, fast on medium docs, well-typed, MIT-licensed, Meta-maintained, robust IME handling.

**Where weaver diverges:** Lexical's collab story is `@lexical/yjs` — a bidirectional sync layer between EditorState and a Y.Doc. The two states must be kept in lockstep; this is where the dual-state bugs we mention in [`architecture.md` §2](architecture.md#2-document-model--lorodoc-as-single-source-of-truth) come from. Lexical also has no first-class AI agent model, and its history stack is independent of the CRDT (so undo across peers is bolted on).

**When Lexical is the right pick:** you want a mature, React-first editor today, you don't need real-time collab with humans + agents, and you'd rather not bet on a young CRDT.

---

### ProseMirror

The gold standard for serious rich-text work. Marijn Haverbeke's schema-first toolkit, used by Atlassian, the New York Times, Notion-likes, and many CMSes.

**Strengths:** Best-in-class schema model (strict, declarative, repairs invalid states); mature collab via `y-prosemirror`; battle-tested at scale; excellent docs.

**Where weaver diverges:** ProseMirror has its own document state ("the doc") and applies CRDT changes as transactions translated by `y-prosemirror`. Like Lexical+Y.js, this is two states held in sync — `y-prosemirror` handles most pain, but the design still violates weaver's "CRDT is the truth" axiom. No AI agent model. Not React-native (you bring your own framework glue).

**When ProseMirror is the right pick:** you want the most mature, most correct, schema-strongest editor for serious prose, and you're OK with the learning curve and the dual-state model. For 80% of "I need a real editor" use cases, this is still the right answer.

---

### Tiptap

The most popular React/Vue/Svelte wrapper around ProseMirror, with a huge ecosystem of extensions and a commercial company behind it.

**Strengths:** Massive extension library; Tiptap Pro (commercial) includes collab via Hocuspocus, comments, and recent AI features; great DX; the de facto default for "Notion-style editor in React" today.

**Where weaver diverges:** Tiptap inherits ProseMirror's dual-state-with-Y.js model. AI in Tiptap Pro is generation-as-API, not agent-as-peer — closer to Cursor's tab-complete than to a collaborator. The plugin model is callback-based, not Effect-TS layered.

**When Tiptap is the right pick:** you want a production-ready editor next quarter, you can pay for Pro if you need collab, and "AI as agent peer" isn't core to your product. This will out-feature weaver on day-1 ergonomics for at least a year.

---

### Slate

React-native rich-text editor with a transforms-based mutation API. Smaller ecosystem than Tiptap; **Plate** is the popular framework that wraps Slate with prebuilt features.

**Strengths:** React-idiomatic; flexible; good for unusual UIs.

**Where weaver diverges:** Slate's editing surface is React-managed — the same anti-pattern we explicitly reject in [`architecture.md` §1](architecture.md#1-system-overview) ("React renders chrome, not the surface"). Performance degrades on large docs because the editing surface re-renders. Collab via `slate-yjs` works but has known rough edges, and again is a dual-state design.

**When Slate is the right pick:** rarely a clean win today. If you're already on Slate or you specifically need Plate's prebuilt React components, fine. For greenfield work, Tiptap or Lexical usually beats it.

---

### BlockNote

A Notion-style block editor built on top of Tiptap. Pre-built UI, opinionated blocks, Yjs collab included.

**Strengths:** Fastest path to a "Notion-like" UI; collab works out of the box; MIT-ish license; React-first.

**Where weaver diverges:** Same dual-state collab inheritance from Tiptap. Opinionated UI means less customization headroom than building your own on ProseMirror or weaver. No agent-peer model.

**When BlockNote is the right pick:** you specifically want a Notion-style block UI and you want it now, and your collab needs are mainstream multi-user (not multi-agent).

---

### BlockSuite (and AFFiNE)

[Toeverything's](https://toeverything.info) editor framework, powering [AFFiNE](https://affine.pro). Block-based, multi-modal (page + Edgeless whiteboard + Database block), CRDT-native from the start. Originally on Y.js; **migrating to Loro** (per public commits and discussions). The closest prior art to weaver on architectural axes — and the explicit reference point for what weaver chose **not** to ship.

**Standalone-repo status (May 2026):** The public [`toeverything/blocksuite`](https://github.com/toeverything/blocksuite) repository has been **dormant since July 2025** — last release v0.22.4 (2025-07-01); recent commits are auto-sync "chore: sync affine blocksuite to packages" mirrors from AFFiNE's monorepo, not human feature work. AFFiNE itself ([`toeverything/AFFiNE`](https://github.com/toeverything/AFFiNE)) is healthy and shipping daily; the standalone library has effectively been re-absorbed into the product monorepo. Treat BlockSuite-as-a-library as "watch AFFiNE's monorepo," not "depend on the public package."

**Strengths:** CRDT-native document model; multi-modal (not just prose); local-first ethos; ambitious architecture; mature block-spec system.

**Where weaver diverges (explicitly — see [ADR 0002](adr/0002-notion-style-block-model.md)):**

- **Scope**: weaver is **docs only — no Edgeless whiteboard, no Database block**. BlockSuite ships all three modes; we deliberately do not. Different selection model, different data model, different access-control surface for canvas / DB; the unit economics of building those well don't fit v1.
- **AI as a peer**: AFFiNE has AI features but the agent is not a CRDT peer the way weaver aims to make it.
- **Plugin model**: BlockSuite's block-spec system is its own design; weaver uses Effect-TS Layer composition with mandatory `concurrentSemantics` declarations ([ADR 0003](adr/0003-concurrent-semantics-no-global-rw-aw.md)).
- **Sync target**: BlockSuite/AFFiNE use a more general sync server; weaver commits to Cloudflare Durable Objects + subdoc partitioning + server-side op validation for access control ([`access-control.md`](access-control.md)).

**When BlockSuite/AFFiNE is the right pick:** you want a Notion/Linear-class product with whiteboards and databases, and you're OK adopting their broader stack and current development cadence.

This is still the **closest prior art**, and the most useful codebase to study before Phase 0 — particularly their block-spec design.

---

### Editor.js

Block-based JSON editor. Lightweight, framework-agnostic. Each block is a plugin.

**Strengths:** Simple; clean JSON output; small surface; framework-free.

**Where weaver diverges:** No CRDT, no real-time collab story, no AI-as-peer. Built for blogs/CMS use cases, not high-end editing.

**When Editor.js is the right pick:** you need a lightweight blog-style editor with a clean block-JSON output and no collab requirements.

---

### Quill 2.0

Long-standing editor with a Delta-based op log. Quill 2.0 modernized the codebase.

**Strengths:** Mature; the Delta format is well-understood; small footprint; Loro ships [a Quill integration example](https://loro.dev) ([`loro-quill`](https://github.com/loro-dev/loro-examples-deno)).

**Where weaver diverges:** Quill's data model is a flat Delta — fine for inline content, awkward for structured nested blocks (lists, tables, code). No native collab story without a CRDT plugin. No AI-as-peer.

**When Quill is the right pick:** you have inline-heavy content (comments, simple posts), you want a small bundle, and you don't need nested structure.

---

### CKEditor 5

Enterprise-focused editor with their own real-time-collab service (proprietary OT-based "Cloud Services"). Long lineage; enterprise feature set (tracked changes, comments, revision history) is mature.

**Strengths:** Most polished enterprise collab + tracked-changes story today; mature accessibility; many integrations.

**Where weaver diverges:** Closed/commercial for the parts that matter (cloud collab). Operational Transform under the hood — weaver is CRDT-only by design (research §0 non-goal). Large bundle. Not designed around AI peers.

**When CKEditor 5 is the right pick:** you're an enterprise buying a polished product with vendor support, and the OT model is acceptable.

---

### Milkdown

Markdown-first editor built on ProseMirror.

**Strengths:** Beautiful markdown DX; "what you see is what markdown" model; plugin-rich.

**Where weaver diverges:** Inherits ProseMirror's dual-state-with-Y.js model. Markdown-first is a design choice that loses fidelity on rich content (e.g. callouts, embeds). No AI-as-peer.

**When Milkdown is the right pick:** you want a markdown-native editor for technical writing (docs, blogs) and your content stays inside the markdown subset.

---

### CodeMirror 6 (different domain, listed for orientation)

For code editing, not prose. Mentioned because weaver's code-block plugin will use it.

**Strengths:** Best-in-class incremental editor for code; great perf; modular extension system; Yjs via `y-codemirror.next`.

**Where weaver diverges:** Different problem. weaver is for prose; weaver embeds CodeMirror 6 (via tree-sitter — see [`wasm-strategy.md` §2.3](wasm-strategy.md)) inside code blocks.

---

## Honest caveats on the headline table

- **"Native" CRDT collab.** weaver and BlockSuite are CRDT-as-truth; CKEditor 5 has its own proprietary OT/CRDT-ish engine; everyone else has CRDT support via a plugin layer that maintains a separate document state.
- **"AI as 1st-class".** Most editors have some AI feature (text generation, summarize, rewrite) wired into a side panel or inline completion. **"First-class"** in weaver means the agent is a peer — visible cursor, awareness, scoped grant, edits indistinguishable from a human collaborator's ops in the doc model. Only weaver claims this today; AFFiNE's roadmap may close the gap.
- **"Local-first".** AFFiNE qualifies; most others don't (browser-only state, no offline-first persistence, server-authoritative semantics). Tiptap can be made local-first with Hocuspocus + IndexedDB but it's not the default.
- **"Headless".** Lexical, ProseMirror, Slate, Tiptap, Milkdown all support some form of headless usage. weaver goes further: the core package literally has no React or DOM dependency at all.

---

## When you should NOT pick weaver

We're greenfield; the honest list:

| If… | Pick |
|---|---|
| You need a production editor next quarter | Tiptap, Lexical, or BlockNote |
| You need tracked changes + enterprise support | CKEditor 5 |
| You want a Notion-style block UI out of the box | BlockNote |
| You want the most schema-strict editor | ProseMirror (raw) |
| Your content is markdown-shaped | Milkdown |
| You want a multi-modal canvas (whiteboard + docs + DB) | BlockSuite / AFFiNE (with caveats — see the §"What we'd revisit" notes about their development cadence) |
| Your collab needs are mainstream multi-user (no agent peers) | Tiptap + Hocuspocus, or AFFiNE |
| You can't bet on a young CRDT (Loro) | anything Y.js-based; ProseMirror + y-prosemirror is the safest |
| Your contributors won't learn Effect-TS | Tiptap or Lexical (callback-based plugins) |
| You need Vue or Svelte today | Tiptap (weaver will be React-first in v1) |

---

## When weaver is the right pick

Concretely, weaver is for products where **AI agents are co-authors, not assistants** — and where the difference matters to your UX:

- **Agent-co-authored documents** where multiple agents and humans edit concurrently, with visible cursors, awareness, and scoped permission grants for each agent.
- **Long-running agent workflows** that need cancellation, streaming generation into the doc, and the ability to undo just the agent's edits without touching the user's.
- **Compliance- or audit-conscious environments** where every edit must be cryptographically attributable to an authenticated identity (agent or human), and access control is enforced server-side at the op level.
- **Local-first applications** where the document must work offline and sync through a low-trust transport (Cloudflare DOs) with server-enforced access control.

If none of those bullet points light up for your product, one of the editors above will likely serve you better today.

---

## What we'd revisit if Loro or AFFiNE/BlockSuite changes the landscape

- **If AFFiNE/BlockSuite ships agent-as-peer**, the "AI 1st-class" delta narrows. weaver's remaining differentiation would be: Effect-TS plugin contract; subdoc-partitioned access control; Cloudflare-native sync; Loro-native from day one (not a migration).
- **If Toeverything re-launches BlockSuite as a maintained standalone library** (rather than the current AFFiNE-monorepo-mirror pattern), it becomes a credible "build on" option. Today, depending on `@blocksuite/*` packages means tracking AFFiNE's internal cadence — a real adoption tax for outside teams.
- **If Loro+ProseMirror (`loro-prosemirror`) matures into a production-ready library**, "ProseMirror + Loro + thin Effect-TS plugin layer" becomes a credible alternative to building our own document core. We rejected this on architectural-purity grounds (PM has its own state — same dual-state critique as Lexical+Y.js), but the calculus changes if the dual-state cost in `loro-prosemirror` turns out to be small.
- **If marimo's Loro PR ([#8849](https://github.com/marimo-team/marimo/pull/8849)) ships and stabilizes**, it becomes meaningful Loro production prior art outside the Loro team — derisks the bet further but doesn't change architectural choices.

---

## See also

- [`prd.md`](prd.md) — product brief
- [`architecture.md`](architecture.md) — full architecture rationale
- [`adr/0001-adopt-loro-over-yjs.md`](adr/0001-adopt-loro-over-yjs.md) — why Loro over Y.js / Yrs
