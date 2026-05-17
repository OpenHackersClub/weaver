# Playground — Standalone Demo Webapp

> Status: spec only; implementation pending. The Playground is the public-facing demo that exercises every shipped block kind, mark, agent affordance, and access-control surface in one page — modeled after [playground.lexical.dev](https://playground.lexical.dev). It is **separate from the docs site** and shipped as its own Cloudflare Pages project.

## Why a separate app

| Concern | Why not fold into the docs site |
|---|---|
| **Build cadence** | Docs change with PRs; the Playground changes with editor releases. Different ship cadence, different reviewers. |
| **Bundle profile** | The Playground ships the full editor (Loro WASM, wa-sqlite WASM, tree-sitter parsers, every plugin). The docs site is content-first; bundling 1+ MB of WASM into every spec page is wrong. |
| **Routing & state** | Playground state (current demo doc, selected example, debug panel toggles, agent token) is rich and ephemeral; docs pages are static. |
| **Cost & ownership** | A separate CF Pages project gives the Playground its own deploy status, its own preview URLs, its own analytics, and its own bisect history. |
| **Demonstration** | "Here is weaver running as its own app on Cloudflare Pages" *is* part of the pitch. The Playground is itself a reference deployment shape consumers will copy. |

## What it shows

The Playground is the **answer to "show me the editor"**. It exercises the entire v1 surface:

1. **A working editor instance** populated with a curated demo doc (~50 blocks, every kind, every mark, nested lists, callouts, code blocks with multiple languages, a table, images, embeds, mentions).
2. **Example switcher** — empty doc, demo doc, large doc (10 k blocks for perf demos), agent-collab demo (the **Mock AI agents** feature pre-enabled — see below), multi-tier doc (public / internal / confidential).
3. **Live debug overlays** (toggleable, off by default):
   - **Block tree** — collapsible view of `LoroTree` structure with per-node `kind`, attrs, child count.
   - **Op log** — recent Loro ops with `origin`, version vector delta, container target.
   - **Version vector** — current per-peer state.
   - **Peer panel** — connected peers (humans + agents) with presence cursor positions.
   - **Subdoc map** — which subdoc (a *separate* LoroDoc per [`access-control.md` §5](access-control.md)) each block belongs to; color-coded by membership.
   - **Serialized state** — JSON snapshot + binary update bytes (hex preview).
4. **Time travel** — slider that calls `doc.checkout(version)` and re-renders.
5. **Mock AI agents** — a toggleable feature that joins 0–N scripted agent peers to the demo doc. See [Mock AI agents](#mock-ai-agents) below.
6. **Theme switcher** — light / dark, persisted in `localStorage`.
7. **Permalink** — `?example=<id>&theme=<...>&debug=<...>&agents=<n>` so a URL captures the visible state, including how many mock agents are running.
8. **Self-host snippet** — a copy-pasteable React snippet that instantiates the same editor configuration the demo uses. The thing a visitor wants after "this is cool" is "how do I get this in my app" — the snippet is the answer.

### Mock AI agents

The Playground's headline interactive feature: a visitor can **turn on mock AI agents that join the demo doc as CRDT peers and edit in real time**. This is the demo embodiment of weaver's core commitment — *AI agents are CRDT peers, not API calls* (see [`ai-agent.md` §1](ai-agent.md)).

**The toggle.** From the Playground UI, the visitor enables 0–N mock agent peers. Each enabled agent joins the demo doc as a **real CRDT peer**: a separate in-tab `LoroDoc` whose ops are exchanged in-process with the editor's `LoroDoc`. The two peers run the same merge as any human↔human pair — only the transport is short-circuited. This is the demo-only simplification noted on the example switcher above: production agents connect over WebSocket to the Durable Object as a separate peer (see [`ai-agent.md` §2.1](ai-agent.md)). The Playground demonstrates the *peer model* (op stream, presence, scoped undo), not the *production transport*.

**"Mock" means scripted/deterministic, not LLM-backed.** There is no real LLM API call, no `/api/ai/*` SSE traffic, no network. The agent runtime replays a canned script of edits. The point is to faithfully demonstrate the real-time peer behavior — streaming `LoroText.insert` ops committed with `origin: agent-N` (see [`ai-agent.md` §2.1](ai-agent.md)), a moving presence cursor via `EphemeralStore`, the `agent-pending` mark, concurrent human↔agent merge, and peer-scoped undo (`UndoManager.undo({ origin: agent-N })`) — without the cost or nondeterminism of a live model. The marker-and-undo behavior mirrors [`ai-agent.md` §5](ai-agent.md) exactly.

**Controls:**

- Number of agents (0–N).
- Start / stop per agent.
- Playback speed — how fast the canned script's `insert` ops are committed.
- Per-agent scope — each mock agent works a distinct `Cursor` range, echoing the multi-agent table in [`ai-agent.md` §6](ai-agent.md).
- The "ask" panel — a prompt box that **triggers a mock script** (selects which canned edit sequence an agent replays); it is *not* a live LLM call.

The visitor can keep typing mid-stream while an agent is running, to show Loro merging concurrent human↔agent edits without losing the visitor's caret.

Explicitly **out of scope**:
- Saving user content. No backend persistence for visitor edits; everything is `LoroDoc` in memory + `localStorage` for the active demo's snapshot.
- Authentication. The agent token in the mock-agents feature is a hard-coded scoped Biscuit baked into the build with no real privileges.
- Sync to a real Durable Object. The Playground runs the client + the mock agent runtime; sync is in-process between LoroDoc peers in the same tab.
- A live LLM. The mock agents replay scripted edits; there is no model inference and no AI network traffic (see [Mock AI agents](#mock-ai-agents)).

## Deployment shape

| Concern | Choice |
|---|---|
| Host | Cloudflare Pages |
| Project name | `weaver-playground` |
| Default URL | `https://weaver-playground.pages.dev` |
| Custom domain | `weaver-playground.openhackers.club` (per the `ohc/<project>` convention; one-time DNS step) |
| Repo location | `apps/playground/` (sibling of `apps/docs/`) |
| Build framework | **Vite + React** (not Astro) — the Playground is an SPA, not a content site. Astro's "islands" model fights the always-on editor surface. |
| Output | Static SPA (`apps/playground/dist`) — same `pages deploy` shape as docs. |
| CI workflow | `.github/workflows/deploy-playground.yml` — mirrors `deploy-pages.yml` but with `--project-name=weaver-playground`. |
| Required CF secrets | Reuses the existing `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets. |
| Build minutes budget | < 90 s per deploy. WASM artifacts are pinned and cached. |

## Information architecture

```
/                       # main editor page; left = examples + debug controls, center = editor, right = side panels
/?example=<id>          # deep-link to an example
/?debug=tree,ops,vv     # comma-separated debug panel ids to enable
/?agents=<n>            # enable n mock AI agent peers on load (0 = off)
/embed/<example>        # bare editor for iframe embedding from third-party sites (no chrome)
/perf                   # perf microsite — runs the benchmark suite in-browser; results table
/about                  # one-page "what this is, link to docs, link to repo"
```

`/perf` is the bridge to [`benchmarks.md`](benchmarks.md): the same suite the offline harness runs, but in the visitor's browser, against a fixed set of reference docs.

## What is needed before implementation starts

| Dependency | Status today | Blocking? |
|---|---|---|
| `@weaver/core` shipping a usable editor build | Pre-implementation | Yes |
| `@weaver/react` chrome (toolbar, slash menu, drag handle) | Pre-implementation | Yes |
| A mock/scripted agent peer runtime that can be sandboxed in-tab | Pre-implementation | Yes — for the Mock AI agents feature only |
| Mock agent script corpus (canned `insert` sequences, per-agent scopes) | TBD | Yes; authored alongside the Playground, see [Mock AI agents](#mock-ai-agents) |
| `@weaver/wasm` Loro + wa-sqlite bundle | Pre-implementation | Yes |
| Demo content seed corpus | TBD | Yes; can be authored alongside the Playground |
| CF Pages project `weaver-playground` created | Not yet | One-line `wrangler` call when ready |
| DNS CNAME `weaver-playground.openhackers.club` → `weaver-playground.pages.dev` | Not yet | When the custom domain is wanted |

## Outcome rubric

The Playground is **shipped** when the following criteria are independently gradeable as true by a reviewer who only sees the deployed `https://weaver-playground.pages.dev`:

### Coverage
- Every block kind listed in [`block-model.md` §3 "Block kinds shipped in v1"](block-model.md) is present at least once in the default demo doc.
- Every mark listed in [`block-model.md` §3 "Marks shipped in v1"](block-model.md) is present at least once in the default demo doc.
- The "large doc" example contains ≥ 10 000 blocks and reaches first paint within ≤ 1500 ms on the canonical machine defined in [`benchmarks.md` §4.5](benchmarks.md).
- The "multi-tier" example renders blocks that belong to at least three distinct subdocs (separate LoroDocs per [`access-control.md` §5](access-control.md)). Each subdoc's blocks render with a distinct CSS border color visible in the DOM; a screenshot shows three distinct colors.

### Mock AI agents

- The Mock AI agents toggle is reachable from the UI and via the `?agents=<n>` permalink param; `?agents=0` (or absent) means no agents running.
- Turning on 2 mock agents shows **two distinct presence cursors**, each carrying `origin: agent-N` on its ops as seen in the op-log overlay.
- At least one streaming insertion from a running mock agent carries the `agent-pending` mark, rendered with the distinct visual per [`ai-agent.md` §5](ai-agent.md).
- The visitor can type concurrently while a mock agent streams, and the visitor's caret position is preserved (no caret jump) — demonstrating Loro merging concurrent human↔agent edits.
- Peer-scoped undo (`UndoManager.undo({ origin: agent-N })`) removes one mock agent's contribution without touching the other agent's edits or the visitor's edits.
- No `/api/ai/*` request and no outbound network call is made while mock agents run (verified via `Page.on('request')` filtering).

### Debug overlays
- Each of the six debug panels (block tree, op log, version vector, peer panel, subdoc map, serialized state) is independently toggleable via URL param and via UI.
- The op log shows `origin` on every entry.
- The version-vector panel's displayed timestamp changes after a single keystroke within 200 ms (measured: subscribe to its text-content mutation; record the delta from the `keydown` event).
- The time-travel slider, when scrubbed, re-renders the editor to the document state at that version with no console errors.

### Self-host snippet
- The "self-host" panel shows a React snippet that imports from `@weaver/react` and `@weaver/core` only — no Playground-internal modules.
- The snippet is copyable with one button click.
- Pasting the snippet into a fresh Vite + React app yields a working editor with the same default plugins as the Playground's default-example configuration. (Reviewer test: run the snippet locally; verify the editor renders.)

### Deployment
- `GET /` returns 200 and the TLS cert presented for `weaver-playground.pages.dev` has `notAfter` ≥ 30 days from the day of the grader's check.
- The build size is ≤ 1.5 MB gzipped including WASM (`docs site` baseline is < 200 KB; the Playground is allowed more because of WASM).
- The deploy workflow runs in ≤ 90 s wall-clock per push and is wired to the `main` branch.
- A push that breaks the build leaves the previously-deployed version in place (Pages atomic deploy; no half-state).

### Output quality
- `GET /`, `GET /perf`, `GET /about`, `GET /embed/<any-example-id>`, and `GET /?example=<each-example-id>` all return 200.
- Loading `/` and `/perf` in a clean Chromium produces zero console errors and zero uncaught promise rejections (verified via `Page.on('pageerror')` and `Page.on('console')` filtering `error` / `warning`).
- The site is usable in a 1024-wide viewport without horizontal scroll.
- An [axe-core](https://github.com/dequelabs/axe-core) accessibility scan of `/` reports zero `serious` or `critical` violations.
- The HTTP response for `/` carries `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` headers (verified by `curl -I`).

### Reproducibility
- Anyone with the repo and the two CF secrets can `pnpm install && pnpm --filter @weaver/playground build && wrangler pages deploy apps/playground/dist --project-name=weaver-playground` and produce a deploy where (a) the set of emitted route paths is identical to CI's artifact and (b) the SHA-256 of `index.html` equals CI's artifact's SHA-256.

## See also

- [`benchmarks.md`](benchmarks.md) — the perf suite the Playground's `/perf` route runs.
- [`lexical-parity.md`](lexical-parity.md) — the feature catalog the Playground demonstrates.
- [`ai-agent.md`](ai-agent.md) — the agent peer model the Mock AI agents feature demonstrates in scripted form.
- [ADR 0001 — Loro over Y.js](adr/0001-adopt-loro-over-yjs.md) — the Loro perf claims the 10k-block example exercises.
- [ADR 0002 — Notion-style block model](adr/0002-notion-style-block-model.md) — the block-kind catalog the demo doc covers.
- [ADR 0005 — Trust model](adr/0005-trust-model.md) — why a hard-coded baked-in capability token in the Mock AI agents feature is acceptable (cooperative-org / trusted-server).
- [Lexical's Playground source](https://github.com/facebook/lexical/tree/main/packages/lexical-playground) — the reference we're modeling against.
