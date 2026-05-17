# Benchmarks — What We Measure, How, and What "Good" Means

> Status: spec only; harness pending. This doc defines the perf bar weaver commits to clearing on day one and the methodology for measuring it across competitor editors. The numbers themselves are not in this file — they belong in CI artifacts and the `/perf` Playground route. This is what gets measured, how, and what counts as passing.

## 1. Why benchmarks now (pre-implementation)

A pre-implementation spec sounds early to commit to numbers. It's not — it's the right time. Two reasons:

1. **Perf is a design input, not a tuning step.** Choosing Loro over Y.js, the imperative DOM surface, the SQLite read-model — each is a perf bet. Stating the bar now constrains the design to deliver on it. Discovering at v0.9 that we missed the bar by 4× is too late.
2. **A perf bar in spec form is a contract reviewers can hold us to.** "It feels fast" is not reviewable; "p95 input-to-paint < 16 ms at 10 k blocks" is.

## 2. Reference documents

Every benchmark runs against a **fixed corpus**. The corpus is committed to the repo under `benchmarks/fixtures/` (when the harness lands) and versioned. Each fixture is described here by shape and target conditions; the actual content is reproducible from a documented generator.

| Fixture | Shape | Why |
|---|---|---|
| `tiny-50` | 50 blocks, ~5 kB serialized | Cold-start floor. |
| `medium-2k` | 2 000 blocks, mixed kinds (paragraphs, headings, lists, callouts, one code block, one table, one image), nesting depth ≤ 3, ~120 kB serialized | Realistic working doc; the modal expected size. |
| `large-10k` | 10 000 blocks, similar mix, depth ≤ 4, ~600 kB serialized | "Long doc" stress test. |
| `huge-100k` | 100 000 blocks, mostly paragraphs, depth ≤ 4, ~6 MB serialized | Out-past-the-bar test; we are *not* expected to be interactive here, only to load and scroll. |
| `op-replay-100k` | 100 000 CRDT ops applied sequentially (insert / delete / mark) to an empty doc, ending in a `medium-2k`-shaped result | CRDT apply path; this is the Loro vs. Y.js ceiling test. |
| `concurrent-edits-2p` | Two peers each issuing 10 000 ops over a shared doc, ~50% overlapping ranges | Merge cost and concurrent rebase. |
| `agent-stream-5k` | One agent peer streams 5 000 character inserts (~50 chars/sec simulated; LLM-rate) while a human peer types in parallel | Agent-collab realistic workload. |
| `marks-dense` | 1 000 blocks with average 5 overlapping marks per text-bearing block | Mark serialization + rendering. |

Each fixture has a deterministic generator (`benchmarks/fixtures/generate.ts`); the binary fixture files are byte-stable. The generator is in scope of the benchmarks harness, not the editor.

## 3. Metrics

Each metric is defined by (a) what is measured, (b) where it is measured from, and (c) the pass threshold for v1.

### 3.1 Init / load

Cold-cache and warm-cache numbers are stated separately because their dominant costs differ. Cold-cache includes WASM (Loro + wa-sqlite, ~1.5–3 MB) instantiate + first-paint; warm-cache assumes both WASM modules are in the HTTP cache and the JIT has primed.

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Cold init (cold cache)** | Time from `<WeaverEditor>` mount to first paint of all visible blocks; HTTP cache empty, fresh Chromium context | `medium-2k` | ≤ 500 ms p50, ≤ 800 ms p95 |
| **Cold init (warm cache)** | Same, with WASM modules already in disk cache | `medium-2k` | ≤ 250 ms p50, ≤ 400 ms p95 |
| **Snapshot import** | Time from `Loro.import(bytes)` call to return | `large-10k` | ≤ 80 ms p50 |
| **Snapshot import (huge)** | Same | `huge-100k` | ≤ 500 ms p50 |
| **Snapshot → first paint (huge)** | Time from `Loro.import(bytes)` call to first paint of the first visible block (assumes virtualization on; see §4.6) | `huge-100k` | ≤ 1500 ms p50 |
| **Op replay** | Time to apply N ops sequentially from an empty doc; see §4.2 "Y.js baseline definition" for the comparison-baseline contract | `op-replay-100k` | ≤ 1 200 ms p50; ≥ 3× faster than the pinned Y.js baseline on the same machine ([ADR 0001](adr/0001-adopt-loro-over-yjs.md)) |

### 3.2 Input latency

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Keystroke-to-paint** | Time from `keypress` event in the contenteditable surface to the paint frame containing the new character (measured via `PerformanceObserver('event')` for compatibility with INP) | `medium-2k` | ≤ 16 ms p95 (single 60 Hz frame) |
| **Keystroke-to-paint (large)** | Same; virtualization is required to make this achievable (see §4.6) | `large-10k` | ≤ 33 ms p95 (two frames) |
| **INP (Interaction-to-Next-Paint)** | The Chrome 2026 responsiveness metric: 75th percentile of all interaction latencies over a sustained typing trace (`PerformanceObserver({ type: 'event', durationThreshold: 16 })`) | `medium-2k`, 60 s of synthesized typing | ≤ 200 ms p75 ("Good" per web.dev INP thresholds), preferably ≤ 100 ms |
| **IME composition latency** | Time from `compositionupdate` event to paint of the composed character (CJK / dead-key paths take a different route through the contenteditable surface than `keypress`) | `medium-2k`, simulated kana / hanzi composition via CDP `Input.imeSetComposition` | ≤ 33 ms p95 |
| **Mark toggle** | Time from `dispatchCommand("toggleBold", selection)` to paint of the formatted run | `medium-2k`, selection covers 20 chars | ≤ 16 ms p95 |
| **Block transform** | Time from `block.transform(id, "heading")` to paint | `medium-2k` | ≤ 16 ms p95 |
| **Large paste** | Time from `paste` event (10 000 chars, marked HTML) to first paint of the pasted content | `medium-2k` | ≤ 250 ms p95 |
| **Undo on long history** | Time from `editor.undo()` to paint, after a 10 000-op history accumulated in one tab session | `medium-2k` + 10 000 prior ops | ≤ 50 ms p95 |
| **Scroll-while-typing dropped frames** | Count of dropped frames (frames > 16.67 ms) during a 5 s typing + smooth-scroll trace | `large-10k` | ≤ 5 dropped frames per 5 s |
| **Long Tasks** | Sum of `PerformanceLongTaskTiming` entries during a 60 s typing trace | `medium-2k` | ≤ 200 ms total |

### 3.3 Collaboration

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Concurrent merge** | Time from receiving a 10-op remote update to it being painted, while the local peer is typing | `concurrent-edits-2p` mid-stream | ≤ 33 ms p95 |
| **Op encode + send** | Time to encode a single local op for the wire | live typing on `medium-2k` | ≤ 1 ms p99 |
| **Op decode + apply** | Time to decode a 100-op batch from the wire and apply | live typing on `medium-2k` | ≤ 10 ms p95 |
| **Awareness fan-out** | Time from a peer's `EphemeralStore` update to it appearing on this peer's UI | 5 connected peers | ≤ 100 ms p95 |

### 3.4 Memory

Heap numbers assume the `UndoManager` history-trim policy documented in `architecture.md` §2 (default-bounded peer-scoped retention; not unbounded). Without that policy, "after-init" heap is meaningless because the test never edits the doc.

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Heap idle** | `performance.measureUserAgentSpecificMemory()` ten seconds after init, no edits, after forced GC | `medium-2k` | ≤ 80 MB |
| **Heap idle (large)** | Same | `large-10k` | ≤ 200 MB |
| **Heap peak during typing** | Maximum of `performance.measureUserAgentSpecificMemory()` sampled every 1 s during a 60 s typing trace, *before* GC | `medium-2k`, 60 s typing | ≤ 1.5× the idle figure |
| **Heap growth per op** | Linear-regression slope of heap vs. ops applied during `op-replay-100k`, post-GC | `op-replay-100k` | ≤ 64 B/op |
| **OPFS tab-restore** | Time from new-tab navigation (cold) to first paint of a doc previously OPFS-persisted (no network) | `medium-2k` persisted | ≤ 600 ms p95 |

### 3.5 Bundle size

Targets match [`prd.md` §8 "Success criteria / Quantitative"](prd.md).

| Metric | Definition | Pass bar (v1) |
|---|---|---|
| **Client bundle (core)** | `@weaver/core` + `@weaver/dom` + `@weaver/react` + Loro WASM, gzipped | ≤ 600 KB |
| **Server bundle** | `@weaver/server` (DO worker), gzipped | ≤ 1 MB |
| **Playground bundle** | `apps/playground/dist` total, gzipped | ≤ 1.5 MB |

### 3.6 Web vitals & Lighthouse — for the docs site and the Playground

A separate concern from editor perf: how the *shipped sites* (the docs site and the future Playground) score on web vitals. We run Lighthouse + a Web-Vitals capture pass on every deployment so the public-facing surfaces don't silently regress.

| Metric | Definition | Surface | Pass bar (v1) |
|---|---|---|---|
| **LCP** (Largest Contentful Paint) | web.dev definition | docs site `/`, `/docs/<each>` | ≤ 2 500 ms p75 ("Good") |
| **LCP — Playground `/`** | same | Playground `/` | ≤ 2 500 ms p75 (Playground budget acknowledges WASM init) |
| **CLS** (Cumulative Layout Shift) | web.dev definition | docs site, Playground | ≤ 0.1 |
| **INP** (Interaction-to-Next-Paint) | web.dev definition | docs site (navigation only), Playground `/` (editor typing) | ≤ 200 ms; ≤ 100 ms preferred |
| **TBT** (Total Blocking Time) | Lighthouse lab metric | docs site, Playground | ≤ 200 ms |
| **Lighthouse — Performance score** | Lighthouse 12+ on mobile emulation (Slow 4G, 4× CPU throttling) | docs site `/`, `/docs/architecture` | ≥ 90 |
| **Lighthouse — Performance score** | same | Playground `/` | ≥ 70 (lower bar; WASM init dominates) |
| **Lighthouse — Accessibility** | Lighthouse | docs site, Playground | ≥ 95 |
| **Lighthouse — Best Practices** | Lighthouse | docs site, Playground | ≥ 95 |
| **Lighthouse — SEO** | Lighthouse | docs site | ≥ 95 (Playground is exempt; not indexed) |
| **No new errors in console** | Lighthouse "no-vulnerable-libraries" + "errors-in-console" audits | docs site, Playground | both pass |

#### How Lighthouse runs

- **CI workflow** `.github/workflows/lighthouse.yml` runs on every push to `main` and on PRs that touch `apps/docs/**` or `apps/playground/**`. It uses [`treosh/lighthouse-ci-action@v12`](https://github.com/treosh/lighthouse-ci-action) against the deployed Pages preview URL (PRs) or the production URL (main).
- **Config** lives at `apps/docs/lighthouserc.json` and `apps/playground/lighthouserc.json` — each lists the URLs to audit, the assertions (above), and the LHCI server token (a public-server token for the OSS LHCI dashboard, no secrets needed).
- **PR comments** — the action posts a comment with the score deltas; a red ✗ on any assertion fails the check.
- **Field data** — once the sites have visitors, a `web-vitals` JS shim captures real-user LCP/INP/CLS and POSTs to a CF Worker that writes to D1. The dashboard at `weaver-docs.pages.dev/perf/field` shows p75 over the last 7 days. (Field data is reporting-only; the pass bar is on the CI Lighthouse number.)

This is intentionally separate from §3.1–3.4 (editor-perf benchmarks). The editor-perf suite measures the *library*; Lighthouse + web vitals measure the *deployed product*. A passing editor with a failing Lighthouse is still a failing release.

### 3.7 Server-side (Cloudflare Durable Object)

DO numbers assume same-colo for client and DO (i.e., the WebSocket lands on the colo nearest the client; CF routes that way by default). Cross-region jitter is *not* what this section measures — it's a network concern, not a server-perf one.

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **DO accept op** | Time from WS frame arrival at the DO to op accepted, persisted, and broadcast | live `medium-2k`, single op, same-colo | ≤ 20 ms p95 |
| **DO snapshot serve** | Time to read R2 snapshot, decode, send | `large-10k` | ≤ 400 ms p95 |
| **DO write-gate check** | Time for the tier-write **per-frame** check (per [ADR 0005](adr/0005-trust-model.md) — not per-op validation; the cooperative-org trust model replaces the per-op pipeline with a frame-granularity gate) | live `medium-2k` | ≤ 1 ms p99 |

## 4. Methodology

### 4.1 Where benchmarks run

| Suite | Where | When |
|---|---|---|
| **In-browser micro** (init, input latency, mark toggle, block transform) | Headless Chromium via Playwright (pinned); inputs use CDP `Input.dispatchKeyEvent` (`rawKeyDown` + `char`), not Playwright's synthesized `keypress`; latency captured via `PerformanceObserver({ type: 'event' })` for INP-compatible numbers | Every PR + nightly main |
| **Heap / memory** | Headless Chromium with `performance.measureUserAgentSpecificMemory()`; forced GC via CDP `HeapProfiler.collectGarbage` | Nightly main only (variance) |
| **Op-replay / merge** | Pure Node.js (Loro WASM, no DOM) | Every PR |
| **DO server** | `workerd` test runner with a stubbed R2 | Nightly main + on-demand |
| **Lighthouse / Web Vitals** | Headless Chromium driven by LHCI; mobile emulation profile (Slow 4G, 4× CPU) | On every push to `main` and on PRs touching `apps/docs/**` or `apps/playground/**` |
| **Playground `/perf`** | The visitor's browser | On-demand; surfaces "perf health" in the deployed Playground for anyone to see |

The same suite definitions back all six runners; the harness is `benchmarks/run.ts` (a typed `@effect/cli` CLI per CLAUDE.md's "Effect-TS CLI over inline shell" guidance).

### 4.2 Comparison editors

For each metric where a meaningful comparison exists, we run the same workload against:

- **Lexical** (no collab; `@lexical/react` v0.21+, vanilla)
- **Lexical + `@lexical/yjs`** (collab; Y.js v13 — see baseline pin below)
- **ProseMirror + `y-prosemirror`**
- **Tiptap + Hocuspocus**
- **CodeMirror 6 + `y-codemirror.next`** — the closest editor to weaver's "imperative DOM patched from CRDT diff" thesis; included specifically so the comparison isn't biased toward React-managed surfaces.
- **BlockSuite (page mode)** once its Loro migration is stable enough to run the harness against
- **Plain `contenteditable`** as a floor

The comparison harness is in `benchmarks/competitors/`; each competitor lives in its own subdirectory with its own minimal app that does *only* what's needed to run the suite. We do not embed competitor editors into the Playground.

The comparison matrix in CI artifacts marks each (metric × competitor) cell as `measured`, `n/a-feature-absent`, or `n/a-licensing`. No blanks. A reviewer can read the matrix and see exactly what was run.

Comparisons are reported as **ratios** alongside the **absolute** number — absolute numbers vary across hardware, but the absolute number is what catches "the ratio looks great but the editor is unusable" cases. Both must appear in the artifact.

#### Y.js baseline definition (the contract behind "≥ 3× faster than Y.js")

The op-replay-100k comparison against Y.js is pinned to this exact configuration so the ratio is falsifiable. Changing any of these is a benchmark-result-invalidating event and bumps `benchmarks/results/<date>/schema_version`.

| Knob | Pinned value |
|---|---|
| Y.js version | `yjs@13.6.x` (latest 13.6 minor at the time of the comparison run; lockfile-pinned per-run) |
| Encoding | v2 (`Y.encodeStateAsUpdateV2`) |
| Transact strategy | One `Y.transact(doc, () => { … })` wrapping the entire 100k-op replay |
| GC | enabled (Y.js default; `Y.Doc({ gc: true })`) |
| Framing | `y-protocols/sync` is **not** included; the comparison measures `Y.applyUpdateV2` cost, not network framing |
| Memory snapshot point | after replay completes, before `Y.encodeStateAsUpdateV2`, after one forced GC |

The Loro side runs against `loro-crdt@<pinned>` (matching `@weaver/wasm`'s pinned version) with identical batching semantics (one outer transaction wrapping all 100k ops).

### 4.3 Hardware baseline

The CI runner is pinned to `runs-on: ubuntu-24.04` (not `ubuntu-latest`, which silently shifts under us). Each result JSON includes the runner OS, kernel, `/proc/cpuinfo` CPU model, total RAM, Chromium version (pinned via `npx playwright install chromium@<sha>`), Node version, and `pnpm` version.

For numbers reported in marketing / READMEs, the canonical machine is an Apple M2 (8c/8GPU) MacBook Air, 16 GB RAM, macOS 14+, Chromium 138+. On macOS, the machine must be on AC power and **not** in Low Power Mode; the `pmset -g batt` output is captured in the artifact for the run that produced the headline number. We do *not* quote benchmarks from local developer machines without that capture.

### 4.4 Statistical method

- Each metric runs **N=50** iterations after **5** warmup iterations. (Up from N=20 in earlier drafts of this spec — N=50 gives ~80% power to detect a 20% mean shift at α=0.05 under typical p95 noise.)
- Cold-cache metrics each get their own browser context with HTTP cache cleared.
- p50 / p95 / p99 are reported; the pass bar is what the **§3 table** says (mostly p95).
- Regression detection uses a **Mann-Whitney U** test between the PR's N=50 samples and the baseline's N=50 samples; p < 0.01 with a median shift ≥ 20% counts as a regression. A simple "two-consecutive misses" rule applies on top, to catch slow drifts that don't trip MWU.

### 4.5 Reproducibility

A contributor with the repo, the pinned Node version (declared in `package.json#engines`), the pinned `pnpm` version (declared in `packageManager`), and the Playwright-pinned Chromium can run:

```sh
pnpm --filter @weaver/benchmarks bench --fixture=medium-2k --suite=input
```

and produce results where, for every metric in §3, `abs(local_p95 - ci_p95) / ci_p95 ≤ 0.15`. The harness writes results to `benchmarks/results/<date>/<commit>.json` and to a markdown summary suitable for pasting into a PR comment.

The result JSON includes:
- `runner.os`, `runner.kernel`, `runner.cpu` (from `/proc/cpuinfo`), `runner.ramMB`
- `chromium.version` (from `playwright --version`)
- `node.version`, `pnpm.version`
- `fixtureSeed` (the integer seed used by `benchmarks/fixtures/generate.ts`)
- `schemaVersion` (an integer; the JSON schema is published at `benchmarks/results-schema/v<n>.json` and changes bump the integer)

### 4.6 Virtualization

Pass bars at `large-10k` and `huge-100k` assume block-level virtualization is on (only blocks within ±1 viewport of the visible area are mounted; off-screen blocks render as fixed-height placeholders). Without virtualization, the React reconciler dominates and the bars are unreachable on any current hardware. The virtualization design lives in `architecture.md` §3; the benchmark harness's "large" fixtures verify it stays on.

## 5. What is *not* a benchmark

To keep the list honest about what we don't measure:

- **Subjective "feel."** No `<some abstract editor>` "feels snappier" claim ever appears in benchmark output; only measured numbers.
- **Feature parity.** Belongs in [`lexical-parity.md`](lexical-parity.md), not here.
- **Coverage.** "We test on Chrome and Firefox" is a release-engineering concern, not a perf bar.
- **AI inference latency.** The LLM round-trip dominates anything else; not a property of the editor.
- **Network latency on real networks.** We synthesize the WebSocket transport in CI; real-network numbers go in field reports, not the benchmark suite.

## 6. Failure modes and escalation

| Symptom | Likely cause | First action |
|---|---|---|
| Cold init regresses ≥ 20% | New synchronous work in mount path | Bisect the last 10 commits to the affected suite |
| Keystroke-to-paint regresses ≥ 20% | DOM patch slowdown or extra subscriber on hot path | Profile with Chrome DevTools Performance tab, attach trace |
| Heap-per-op regresses | New allocation per op in the editor core | Diff `heap-snapshot` between baseline and PR |
| Op-replay regresses while concurrent-merge stays flat | Loro WASM build issue | Check `@weaver/wasm` version pin |
| Concurrent-merge regresses while op-replay stays flat | Editor-layer subscriber thrash | Check `useBlock` selector equality |

## Outcome rubric

The benchmarks suite is **delivered** when an independent grader, seeing only the deployed Playground `/perf` route, the CI nightly artifact for `main`, and this spec, can mark each criterion below as binary pass/fail.

### Coverage
- A harness exists under `benchmarks/` that implements every metric in §3.
- Every fixture in §2 is reproducibly generated by a script under `benchmarks/fixtures/`; running the script twice yields byte-identical fixture files.
- A nightly CI run executes the full suite on `main` and uploads the JSON results as an artifact retained ≥ 30 days.
- A per-PR CI run executes the **fast** subset (§4.1 column "Every PR") in ≤ 5 minutes wall-clock.

### Pass thresholds
- Every "Pass bar (v1)" cell in §3 has a corresponding green check on the most recent nightly run.
- The comparison matrix in §4.2 marks each (metric × competitor) cell as exactly one of `measured`, `n/a-feature-absent`, `n/a-licensing`. No blank cells. (Grader test: scan the artifact; reject if any cell is empty.)
- For `op-replay-100k`, weaver is at least **3× faster** than the Y.js baseline pinned in §4.2 "Y.js baseline definition" on the same hardware. The artifact reports both the absolute weaver number and the absolute Y.js number alongside the ratio.
- For `keystroke-to-paint` at `medium-2k`, p95 ≤ 16 ms on the canonical machine (CI runner numbers are annotated with their machine generation per §4.3).
- For Lighthouse (§3.6), each pass bar is enforced as an LHCI assertion configured at `apps/docs/lighthouserc.json` / `apps/playground/lighthouserc.json`; a missing assertion is itself a rubric failure.

### Reporting
- The Playground `/perf` route renders a table of the latest results for at least the §3.1, §3.2, §3.4 metrics, runnable on visit.
- A regression-detector script exists at `benchmarks/scripts/detect-regression.ts`; on a PR, the CI workflow invokes it and posts a PR comment whenever any §3 metric crosses its pass bar or regresses by ≥ 20% on the Mann-Whitney U test (§4.4). Grader test: induce a synthetic 25% slowdown in a test PR; verify the comment appears.
- Each metric's table row in the artifact shows: pass-bar target, latest p50/p95, previous-run p95, percent delta, ratio vs. best non-weaver competitor.
- The result JSON schema is published at `benchmarks/results-schema/v<n>.json` (per §4.5); breaking changes bump `schemaVersion`.

### Reproducibility
- A contributor following §4.5 produces, on the canonical machine, results where for every §3 metric `abs(local_p95 - ci_p95) / ci_p95 ≤ 0.15`.
- The result JSON file path matches the schema documented in §4.5 (the listed keys are all present).
- A flakiness budget: across the most recent five nightly runs, the p95 of the per-run p95 varies by ≤ 10% for every §3 metric; a metric outside this band is flagged as "unstable" in the artifact and excluded from regression detection until restabilized.

### Output quality
- Each §3 metric row specifies all four of: input fixture id, sample count, warmup count, and the unit of the pass-bar number.
- The harness emits exactly one JSON file per run, matching the §4.5 schema; results are not stored as screenshots.
- The pass-bar table in §3 is the **single source of truth** for "is this passing" — no parallel pass/fail tracking elsewhere in the corpus or in CI.

## See also

- [`playground.md`](playground.md) — the `/perf` route surfaces these numbers to visitors.
- [`lexical-parity.md`](lexical-parity.md) — the feature surface the perf bar must hold for.
- [`wasm-strategy.md`](wasm-strategy.md) — the Loro / wa-sqlite perf assumptions this suite verifies.
- [ADR 0001](adr/0001-adopt-loro-over-yjs.md) — the Loro-over-Y.js perf claims this suite validates.
- [`hard-problems.md`](hard-problems.md) — the implementation problems whose perf consequences this suite catches.
