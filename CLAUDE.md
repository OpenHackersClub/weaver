# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: docs-first, pre-implementation

There is no editor code yet. The repo is a **design corpus + a deployed docs site**. Work that "ships" today is:

- Spec edits under `specs/` — the source of truth for every architectural commitment.
- Astro docs site under `apps/docs/` — renders `specs/` to <https://weaver-docs.pages.dev> (CF Pages; `weaver.openhackers.club` once DNS is in).
- ADRs under `specs/adr/0001..0007` — these are load-bearing; do not contradict them silently in a new spec, raise a new ADR or amend the existing one.

When asked to "implement X" without specs in place, push back on the order: spec → ADR (if architectural) → code.

## Common commands

All commands run from the repo root using pnpm workspaces (`packageManager: pnpm@9.12.0`, Node ≥ 20.18).

```sh
pnpm install                           # bootstrap (frozen lockfile in CI)

pnpm dev                               # docs site dev server, http://127.0.0.1:4322/
pnpm build                             # docs site production build
pnpm preview                           # serve the built docs site

pnpm --filter @weaver/docs check       # astro check — typecheck the docs site
pnpm --filter @weaver/docs build       # equivalent to root `pnpm build`
```

There is no test runner yet — when adding tests, follow the workspace pattern (`pnpm --filter <pkg> test`). Don't introduce a root-level test script that bypasses the workspace filter.

## Architecture — the big picture

### Repo layout

- **`apps/docs/`** — Astro v5 docs site. Reads `specs/**/*.md` via Astro's content collection (`apps/docs/src/content.config.ts`). Mermaid diagrams are rendered client-side via `src/components/MermaidRunner.astro` + `src/lib/remark-mermaid.mjs` and ship with a hover toolbar (Expand fullscreen modal + Open-in-new-tab).
- **`specs/`** — the design corpus. The canonical entry point is `prd.md`; the architectural backbone is `architecture.md`; implementation lives in topical specs (`block-model.md`, `access-control.md`, `ai-agent.md`, `wasm-strategy.md`, `hard-problems.md`, `comparison.md`, `lexical-parity.md`, `benchmarks.md`, `playground.md`).
- **`specs/adr/`** — Architectural Decision Records (0001–0007 currently). Each ADR has `Status`, `Decision`, alternatives, costs, reversibility triggers.
- **`packages/`** — empty placeholder; future `@weaver/core`, `@weaver/dom`, `@weaver/react`, `@weaver/sync`, `@weaver/agent`, `@weaver/wasm`, `@weaver/server`, `@weaver/plugins-*` will land here.

### The product-level commitments

These come from `prd.md` §10 (decisions index D1–D16) and the seven ADRs. Read them before editing anything architecturally adjacent:

1. **LoroDoc is the single source of truth** (D1, ADR 0001). No parallel editor state. Anything that must sync / audit / undo goes through LoroDoc.
2. **Notion-style block model** (D11, ADR 0002). Blocks only — no whiteboard, no Database; the `embed` block is the escape hatch.
3. **Concurrent semantics declared per plugin** (ADR 0003); no global remove-wins / add-wins rule.
4. **Biscuit capability tokens** for delegation (ADR 0004).
5. **Cooperative-org / trusted-server trust model** (ADR 0005). Not zero-trust insider defense; access control's job is org-level data scoping + audit-grade attribution. Jazz's [classic post-mortem](https://jazz.tools/blog/what-we-learned-from-classic-jazz) corroborates this choice.
6. **AI agents as CRDT peers**, not API calls (D9, `ai-agent.md`). Prompt-injected agents are the sharpest remaining adversary (ADR 0006).
7. **Effect-TS at the boundaries — *including* UI state** (D3 + D4 + ADR 0007). Plugin contract, sync, AI workflows, *and* ephemeral UI state all use Effect (`SubscriptionRef`, `PubSub`, `Layer`, `Match.tag`). Do not introduce Valtio / Zustand / Jotai — ADR 0007 forecloses them.
8. **Docs only — no canvas or DB v1**; future tabular work goes through the `query-embed` block kind, not a Database block (ADR 0002).

### State layering rule (load-bearing)

| State kind | Owner |
|---|---|
| Document content (blocks, marks, inline text, comments, ACL tag) | **LoroDoc** |
| Canonical selection | `Cursor` anchors in a `LoroMap` |
| Peer presence / awareness | **Loro `EphemeralStore`** |
| Ephemeral UI (toolbar, menus, hover, drag preview, per-block flags) | **Effect-TS `SubscriptionRef`** (`EditorUiStore` / `BlockUiStore`) |
| Component-local UI | `useState` (only if no second component reads it) |

If a thing should survive reload or travel over the network, it's LoroDoc. Otherwise, it's an `EffectSubscriptionRef`. This split is enforced socially via review; there is no runtime guard.

## CI & deployment

- **`.github/workflows/ci.yml`** — `astro check` + `astro build` on every push to `main` and every PR. Uploads `dist/` as an artifact on `main` runs.
- **`.github/workflows/deploy-pages.yml`** — on push to `main` (and `workflow_dispatch`), builds and deploys to Cloudflare Pages project `weaver-docs` via `cloudflare/wrangler-action@v3`. Requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **`apps/docs/wrangler.toml`** — declares `name = "weaver-docs"` and `pages_build_output_dir = "./dist"`.
- **`apps/docs/astro.config.mjs`** — `site = "https://weaver.openhackers.club"`; `vite.server.allowedHosts` and `vite.preview.allowedHosts` are set to `[".ts.net"]` so `tailscale serve` works without per-host config.

## Conventions specific to this repo

- **Subdomain**: per the `ohc/<project>` convention this repo lives under, the production URL is `<project>.openhackers.club` (`weaver.openhackers.club`). A future Playground app under `apps/playground/` is spec'd to deploy as a separate Pages project `weaver-playground` at `weaver-playground.openhackers.club` — see `specs/playground.md`.
- **No criticism of other editors outside `specs/comparison.md`.** Architectural specs name design *patterns* (e.g. "two-state editor + CRDT replica") rather than products. The competitor-by-competitor narrative lives only in `comparison.md`.
- **Mermaid over ASCII** for any architecture / sequence / flow diagram in specs.
- **PRD D4 + ADR 0007**: when discussing UI state, the language is "`SubscriptionRef` store" or "Effect-TS UI state," never "Valtio" (the ADR superseded it). Old references in `comparison.md` are allowed for historical context only.

## Where to look first

- New to the repo → read `README.md`, then `specs/prd.md` (vision + decisions index), then `specs/architecture.md`.
- Adding a block kind → `specs/block-model.md` + ADR 0002 + ADR 0003 (concurrent semantics).
- Touching auth / access → `specs/access-control.md` + ADR 0004 + ADR 0005.
- Touching the AI agent surface → `specs/ai-agent.md` + ADR 0006.
- Touching UI state → ADR 0007 + `specs/block-model.md` §6.
- Adding a perf claim → `specs/benchmarks.md` (defines the bar; any new claim needs a fixture + metric + pass threshold there first).
- Mapping a Lexical feature → `specs/lexical-parity.md`.
