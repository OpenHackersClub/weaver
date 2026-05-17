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

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Cold init** | Time from `<WeaverEditor>` mount to first paint of all visible blocks | `medium-2k` | ≤ 250 ms p50, ≤ 500 ms p95 |
| **Snapshot apply** | Time from receiving a `LoroDoc` snapshot blob to `apply()` returning | `large-10k` | ≤ 80 ms p50 |
| **Snapshot apply (huge)** | Same | `huge-100k` | ≤ 800 ms p50 |
| **Op replay** | Time to apply N ops sequentially from an empty doc | `op-replay-100k` | ≤ 1 200 ms p50; ≥ 3× faster than Y.js baseline on the same machine |

### 3.2 Input latency

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Keystroke-to-paint** | Time from `keypress` event in the contenteditable surface to the paint frame containing the new character | `medium-2k` | ≤ 16 ms p95 (single 60 Hz frame) |
| **Keystroke-to-paint (large)** | Same | `large-10k` | ≤ 33 ms p95 (two frames) |
| **Mark toggle** | Time from `dispatchCommand("toggleBold", selection)` to paint of the formatted run | `medium-2k`, selection covers 20 chars | ≤ 16 ms p95 |
| **Block transform** | Time from `block.transform(id, "heading")` to paint | `medium-2k` | ≤ 16 ms p95 |

### 3.3 Collaboration

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Concurrent merge** | Time from receiving a 10-op remote update to it being painted, while the local peer is typing | `concurrent-edits-2p` mid-stream | ≤ 33 ms p95 |
| **Op encode + send** | Time to encode a single local op for the wire | live typing on `medium-2k` | ≤ 1 ms p99 |
| **Op decode + apply** | Time to decode a 100-op batch from the wire and apply | live typing on `medium-2k` | ≤ 10 ms p95 |
| **Awareness fan-out** | Time from a peer's `EphemeralStore` update to it appearing on this peer's UI | 5 connected peers | ≤ 100 ms p95 |

### 3.4 Memory

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **Heap after init** | `performance.memory.usedJSHeapSize` ten seconds after init, no edits, GC nudged | `medium-2k` | ≤ 80 MB |
| **Heap after init (large)** | Same | `large-10k` | ≤ 200 MB |
| **Heap growth per op** | Linear-regression slope of heap vs. ops applied during `op-replay-100k`, post-GC | `op-replay-100k` | ≤ 64 B/op |

### 3.5 Bundle size

| Metric | Definition | Pass bar (v1) |
|---|---|---|
| **Client bundle (core)** | `@weaver/core` + `@weaver/dom` + `@weaver/react` + Loro WASM, gzipped | ≤ 600 KB (matches PRD §"Worker / client targets") |
| **Server bundle** | `@weaver/server` (DO worker), gzipped | ≤ 1 MB (matches PRD) |
| **Playground bundle** | `apps/playground/dist` total, gzipped | ≤ 1.5 MB |

### 3.6 Server-side (Cloudflare Durable Object)

| Metric | Definition | Fixture | Pass bar (v1) |
|---|---|---|---|
| **DO accept op** | Time from WS frame arrival to op accepted and broadcast | live `medium-2k`, single op | ≤ 20 ms p95 (DO machine) |
| **DO snapshot serve** | Time to read R2 snapshot, decode, send | `large-10k` | ≤ 400 ms p95 |
| **DO write-gate check** | Time for the tier-write gate check on inbound frame | live `medium-2k` | ≤ 1 ms p99 |

## 4. Methodology

### 4.1 Where benchmarks run

| Suite | Where | When |
|---|---|---|
| **In-browser micro** (init, input latency, mark toggle, block transform) | Headless Chromium via Playwright, in CI | Every PR + nightly main |
| **Heap / memory** | Headless Chromium with `--enable-precise-memory-info`; deterministic GC nudges | Nightly main only (variance) |
| **Op-replay / merge** | Pure Node.js (Loro WASM, no DOM) | Every PR |
| **DO server** | `workerd` test runner with a stubbed R2 | Nightly main + on-demand |
| **Playground `/perf`** | The visitor's browser | On-demand; surfaces "perf health" in the deployed Playground for anyone to see |

The same suite definitions back all five runners; the harness is `benchmarks/run.ts` (a typed CLI per CLAUDE.md's "Effect-TS CLI over inline shell" guidance).

### 4.2 Comparison editors

For each metric where a meaningful comparison exists, we run the same workload against:

- **Lexical** (no collab; `@lexical/react` v0.21+, vanilla)
- **Lexical + `@lexical/yjs`** (collab)
- **ProseMirror + `y-prosemirror`**
- **Tiptap + Hocuspocus**
- **BlockSuite (page mode)** when its Loro migration is stable enough to run the harness against
- **Plain `contenteditable`** as a floor

The comparison harness is in `benchmarks/competitors/`; each competitor lives in its own subdirectory with its own minimal app that does *only* what's needed to run the suite. We do not embed competitor editors into the Playground.

Comparisons are reported as **ratios**, not absolute deltas — absolute numbers vary too much across hardware. The pass bar is stated in absolutes (so we have a contract) *and* in ratios (so we can claim "≥ 3× faster than Y.js on op-replay" honestly).

### 4.3 Hardware baseline

The CI runner is `ubuntu-latest` on GitHub Actions. Numbers reported in CI artifacts annotate the runner generation. For numbers reported in marketing / READMEs, the canonical machine is an M2-class laptop with 16 GB RAM and Chromium 138+. We do *not* run benchmarks on local developer machines and quote those.

### 4.4 Statistical method

- Each metric runs **N=20** iterations after **5** warmup iterations.
- Cold-start metrics each get their own browser context (no warm cache).
- p50 / p95 / p99 are reported; the pass bar is what the **table** says (mostly p95).
- A run is flagged failing if it misses the bar in **two consecutive** nightly runs. One miss is noise; two is a regression.

### 4.5 Reproducibility

A contributor with the repo and Node 20 + Chromium installed can run:

```sh
pnpm --filter @weaver/benchmarks bench --fixture=medium-2k --suite=input
```

and produce results that match CI's within hardware-variance tolerance. The harness writes results to `benchmarks/results/<date>/<commit>.json` and to a markdown summary suitable for pasting into a PR comment.

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
- The comparison numbers in §4.2 are present for at least **Lexical**, **Lexical+yjs**, and **Tiptap+Hocuspocus** for every metric where a comparison is meaningful (i.e., not weaver-only features like agent-stream).
- For `op-replay-100k`, weaver is at least **3× faster** than the Y.js-backed baseline on the same hardware. (Grader test: read the ratio from the latest nightly results file.)
- For `keystroke-to-paint` at `medium-2k`, p95 ≤ 16 ms on the canonical machine (CI runner numbers are annotated with their machine generation).

### Reporting
- The Playground `/perf` route renders a table of the latest results for at least the §3.1, §3.2, §3.4 metrics, runnable on visit.
- A PR comment is auto-posted whenever a benchmark metric regresses by ≥ 20% or crosses a pass bar; the comment links to the per-commit results file.
- Each metric's table row shows: target, latest, previous-run, delta, ratio-vs-best-competitor.

### Reproducibility
- A contributor following §4.5 produces, on the canonical machine, results within 15% of the latest CI nightly for every metric in §3.
- The harness emits one JSON file per run with a documented schema; the schema is versioned and a v1→v2 migration is documented if the schema changes.

### Output quality
- Results are stored as JSON, not screenshots.
- The pass bar table in §3 is the **single source of truth** for "is this passing" — no parallel pass/fail tracking elsewhere.
- Each metric definition is unambiguous: a reviewer can read the definition cell and write a runner for it without asking the author.

## See also

- [`playground.md`](playground.md) — the `/perf` route surfaces these numbers to visitors.
- [`lexical-parity.md`](lexical-parity.md) — the feature surface the perf bar must hold for.
- [`wasm-strategy.md`](wasm-strategy.md) — the Loro / wa-sqlite perf assumptions this suite verifies.
- [ADR 0001](adr/0001-adopt-loro-over-yjs.md) — the Loro-over-Y.js perf claims this suite validates.
- [`hard-problems.md`](hard-problems.md) — the implementation problems whose perf consequences this suite catches.
