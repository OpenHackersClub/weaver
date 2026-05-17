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
2. **Example switcher** — empty doc, demo doc, large doc (10 k blocks for perf demos), agent-collab demo (an agent peer running scripted edits), multi-tier doc (public / internal / confidential).
3. **Live debug overlays** (toggleable, off by default):
   - **Block tree** — collapsible view of `LoroTree` structure with per-node `kind`, attrs, child count.
   - **Op log** — recent Loro ops with `origin`, version vector delta, container target.
   - **Version vector** — current per-peer state.
   - **Peer panel** — connected peers (humans + agents) with presence cursor positions.
   - **Subdoc map** — which subdoc each block belongs to; color-coded.
   - **Serialized state** — JSON snapshot + binary update bytes (hex preview).
4. **Time travel** — slider that calls `doc.checkout(version)` and re-renders.
5. **Agent demo controls** — start/stop a scripted agent peer; "ask" panel that sends a prompt to a stub agent runtime.
6. **Theme switcher** — light / dark, persisted in `localStorage`.
7. **Permalink** — `?example=<id>&theme=<...>&debug=<...>` so a URL captures the visible state.
8. **Self-host snippet** — a copy-pasteable React snippet that instantiates the same editor configuration the demo uses. The thing a visitor wants after "this is cool" is "how do I get this in my app" — the snippet is the answer.

Explicitly **out of scope**:
- Saving user content. No backend persistence for visitor edits; everything is `LoroDoc` in memory + `localStorage` for the active demo's snapshot.
- Authentication. The agent token in the agent demo is a hard-coded scoped Biscuit baked into the build with no real privileges.
- Sync to a real Durable Object. The Playground runs the client + the agent runtime; sync is in-process between two LoroDoc peers in the same tab.

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
| At least one agent peer runtime that can be sandboxed in-tab | Pre-implementation | Yes — for the agent demo only |
| `@weaver/wasm` Loro + wa-sqlite bundle | Pre-implementation | Yes |
| Demo content seed corpus | TBD | Yes; can be authored alongside the Playground |
| CF Pages project `weaver-playground` created | Not yet | One-line `wrangler` call when ready |
| DNS CNAME `weaver-playground.openhackers.club` → `weaver-playground.pages.dev` | Not yet | When the custom domain is wanted |

## Outcome rubric

The Playground is **shipped** when the following criteria are independently gradeable as true by a reviewer who only sees the deployed `https://weaver-playground.pages.dev`:

### Coverage
- Every block kind listed in [`block-model.md` §3 "Block kinds shipped in v1"](block-model.md) is present at least once in the default demo doc.
- Every mark listed in [`block-model.md` §3 "Marks shipped in v1"](block-model.md) is present at least once in the default demo doc.
- The "large doc" example contains ≥ 10 000 blocks and loads to first paint within a documented budget (see [`benchmarks.md` §"Init latency"](benchmarks.md)).
- The "agent-collab" example shows a visible second peer cursor with `origin: agent-N` on at least one streaming insertion.
- The "multi-tier" example renders blocks tagged with at least three distinct `subdoc` values, each visually distinguishable.

### Debug overlays
- Each of the six debug panels (block tree, op log, version vector, peer panel, subdoc map, serialized state) is independently toggleable via URL param and via UI.
- The op log shows `origin` on every entry.
- The version vector updates within 200 ms of any local edit.
- The time-travel slider, when scrubbed, re-renders the editor to the document state at that version with no console errors.

### Self-host snippet
- The "self-host" panel shows a React snippet that imports from `@weaver/react` and `@weaver/core` only — no Playground-internal modules.
- The snippet is copyable with one button click.
- Pasting the snippet into a fresh Vite + React app yields a working editor with the same default plugins as the Playground's default-example configuration. (Reviewer test: run the snippet locally; verify the editor renders.)

### Deployment
- The site is reachable at `https://weaver-playground.pages.dev` with a TLS cert that is valid for ≥ 30 days.
- The build size is ≤ 1.5 MB gzipped including WASM (`docs site` baseline is < 200 KB; the Playground is allowed more because of WASM).
- The deploy workflow runs in ≤ 90 s wall-clock per push and is wired to the `main` branch.
- A push that breaks the build leaves the previously-deployed version in place (Pages atomic deploy; no half-state).

### Output quality
- All routes return 200 (no 404 surprises). `/perf` returns 200 even if no benchmark has been seeded.
- The site renders with no console errors and no uncaught promise rejections on a clean Chromium load.
- The site is usable in a 1024-wide viewport without horizontal scroll.

### Reproducibility
- Anyone with the repo and the two CF secrets can `pnpm install && pnpm --filter @weaver/playground build && wrangler pages deploy apps/playground/dist --project-name=weaver-playground` and produce a deploy identical to CI's output (byte-for-byte deterministic where the build chain allows; same set of routes and asset hashes otherwise).

## See also

- [`benchmarks.md`](benchmarks.md) — the perf suite the Playground's `/perf` route runs.
- [`lexical-parity.md`](lexical-parity.md) — the feature catalog the Playground demonstrates.
- [Lexical's Playground source](https://github.com/facebook/lexical/tree/main/packages/lexical-playground) — the reference we're modeling against.
