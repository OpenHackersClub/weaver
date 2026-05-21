# weaver — Implementation Guideline

> Style and idiom rules that bind code-level work across `@weaver/core`, `@weaver/dom`, `@weaver/react`, the v1 plugin set, and the playground. These are the conventions a reviewer is allowed to block on without needing to litigate them in the PR. Architectural decisions (CRDT-as-source-of-truth, block model, trust model) live in the ADRs; this file is the operational layer below them.

The companions a reader of this file may want open: [`prd.md`](prd.md) (D3, D4 — Effect at the boundaries), [`architecture.md`](architecture.md) (where the command bus, plugin contract, and reactivity model are defined), [ADR 0006](adr/0006-ui-state-effect-over-valtio.md) (Effect-TS over Valtio for UI state), and the project-level `CLAUDE.md` Effect-TS section.

## 1. Prefer Effect-TS pattern matching over `switch` / `_tag` checks

When branching over a tagged or literal-union value — block kinds, mark kinds, command tags, agent events, sync messages, plugin op shapes — reach for [`effect/Match`](https://effect.website/docs/code-style/pattern-matching) before `switch` or `if (x._tag === "...")`. This is a hard preference, not a suggestion.

### Why

- **Compile-time exhaustiveness.** `Match.exhaustive` is a type-level closer: leave a case off and TypeScript fails the build. `switch` only narrows when every arm `return`s; you can lose exhaustiveness by adding a side effect after the switch, or by adding a new union member that the compiler then quietly tolerates in the existing `default:` arm.
- **Refactor safety.** Adding a new `BlockKind` (or `MarkKind`, or command tag) surfaces every Match site that hasn't been updated. With `switch + default`, the new case silently falls through to the default and runs in production before anyone notices.
- **Same idiom everywhere.** The plugin contract, command bus, sync workflows, and UI state stores all run through Effect — using `Match` keeps the branching shape consistent with the surrounding code instead of context-switching to a different control-flow construct mid-function.
- **No `._tag` access.** Reading `_tag` directly is brittle: the field is an implementation detail of `Schema.TaggedClass` / `Schema.TaggedError`, and reaching for it bypasses the `Match.tag` / `catchTag` machinery that already understands those types.

### How

For literal-string unions (`BlockKind`, `MarkKind`, `ExampleId`, command names, sync envelope kinds):

```ts
import { Match } from "effect";

const hasInline = (kind: BlockKind): boolean =>
  Match.value(kind).pipe(
    Match.whenOr(
      "paragraph",
      "heading",
      "quote",
      "bullet-list-item",
      "numbered-list-item",
      "to-do",
      "code",
      "toggle",
      "table-cell",
      () => true,
    ),
    Match.whenOr("divider", "image", "embed", "table", "table-row", () => false),
    Match.exhaustive,
  );
```

For tagged objects (`Schema.TaggedClass` / `Schema.TaggedError` / domain events):

```ts
const summarize = (event: DomainEvent): string =>
  Match.value(event).pipe(
    Match.tag("Created", ({ id }) => `+ ${id}`),
    Match.tag("Updated", ({ id }) => `~ ${id}`),
    Match.tag("Deleted", ({ id }) => `- ${id}`),
    Match.exhaustive,
  );
```

For one-liner branches over many tags, `Match.tags({ ... })` is shorter:

```ts
const label = Match.type<DomainEvent>().pipe(
  Match.tags({
    Created: ({ id }) => `+ ${id}`,
    Updated: ({ id }) => `~ ${id}`,
    Deleted: ({ id }) => `- ${id}`,
  }),
  Match.exhaustive,
);
```

### `Match.orElse` is a TODO marker — `Match.exhaustive` is the goal

`Match.orElse(() => defaultValue)` accepts an unhandled remainder; `Match.exhaustive` refuses to compile if any case is missing. **Prefer `exhaustive`.** Use `orElse` only when the unhandled remainder is genuinely heterogeneous (e.g. mapping a structural union to a rendering tag where the mapping is incomplete) and leave a comment that names the follow-up.

```ts
// Image, embed, toggle, and the table family still need DOM mapping —
// tracked in specs/lexical-parity.md §1. When each gets a real branch,
// replace `Match.orElse` with `Match.exhaustive`.
const tagFor = (kind: BlockKind): string =>
  Match.value(kind).pipe(
    Match.when("heading", () => "h1"),
    Match.when("quote", () => "blockquote"),
    // ...
    Match.orElse(() => "p"),
  );
```

A grep for `Match.orElse` should produce a finite, justified list. If it's growing, that's a bug.

### When `switch` is still OK

Three narrow exceptions where a `switch` (or a `_tag` predicate inside a domain combinator) is fine:

1. **Inside `Schedule.whileInput` / `Stream.filter` predicates** that take a `(value) => boolean` and route on `value._tag`. The combinator is the documented API; using `Match.value(...).pipe(Match.tag(...), Match.option)` to fake a boolean is worse.
2. **Hot loops where allocation matters.** `Match` returns a function (closure-allocating). If profiling has shown the branch is on a measurable hot path — text-input keystroke, per-character render, presence-cursor tick — a `switch` is acceptable. Add a comment that names the benchmark that justified it.
3. **Interop boundaries with non-tagged third-party shapes** (DOM events, IndexedDB cursor states, raw Loro container types) — branching on `event.type` from a `MessageEvent` doesn't gain anything from `Match`. Convert as soon as the value crosses into our domain.

If none of these three apply, the answer is `Match`.

## 2. Tagged errors over `throw`

Inside `Effect.gen` / `flatMap` chains, never `throw new Error(...)`. Use `Schema.TaggedError`:

```ts
import { Schema } from "effect";

export class BlockNotFound extends Schema.TaggedError<BlockNotFound>()(
  "BlockNotFound",
  { blockId: Schema.String },
) {}
```

Then `yield* Effect.fail(new BlockNotFound({ blockId }))`. Tagged errors carry typed payloads, survive serialization, and feed `Match.tag` / `Effect.catchTag` directly. Reaching for `throw` bypasses the typed error channel and surfaces the failure as `Defect` rather than a recoverable error.

The exception is **plain TypeScript functions outside any Effect context** (synchronous helpers, validation guards, schema parsers that the surrounding code expects to throw on bad input). Continue throwing there — wrapping every helper in `Effect.try` is overkill — but cross the boundary into tagged errors the moment the value enters an Effect pipeline.

## 3. Error recovery — `catchTag` not `catchAll`

```ts
const program = getBlock(id).pipe(
  Effect.catchTag("BlockNotFound", () => Effect.succeed(emptyBlock)),
  Effect.catchTag("DocLocked", ({ retryAfterMs }) =>
    Effect.sleep(`${retryAfterMs} millis`).pipe(Effect.andThen(getBlock(id))),
  ),
);
```

`catchTag` keeps the typed error channel narrow — the resulting Effect's inferred `E` lists exactly what's still possible. `catchAll` flattens everything; an unrelated bug that throws a new error type silently disappears into the recovery branch. Use `catchAll` only when the recovery genuinely applies to any error (e.g. logging + fallback at the outermost layer of a workflow).

## 4. Generators over deeply-nested `.pipe(...)` chains

When a workflow has multiple sequential steps each producing an intermediate value, prefer `Effect.gen` over nested `flatMap`. The code reads top-to-bottom and the names of the intermediate values stay in scope:

```ts
const applyCommand = (cmd: Command) =>
  Effect.gen(function* () {
    const editor = yield* getCurrentEditor;
    const block = yield* getBlock(editor, cmd.blockId);
    const range = yield* normalizeRange(block, cmd.range);
    return yield* runCommand(editor, block, range, cmd);
  }).pipe(
    Effect.catchTag("BlockNotFound", () =>
      Effect.fail(new CommandFailed({ reason: "missing_block" })),
    ),
  );
```

Reserve `.pipe(Effect.flatMap(...))` chains for short transformations (one or two steps) where there's nothing meaningful to name.

## 5. State ownership — match the [layering rule in CLAUDE.md](#)

This file does not redefine the state layering rule; it points back at the project `CLAUDE.md` "State layering rule (load-bearing)" section and `specs/block-model.md` §6. Implementation work is bound by it:

- Document content → `LoroDoc`.
- Selection → `Cursor` anchors in a `LoroMap`.
- Peer presence → Loro `EphemeralStore`.
- Ephemeral UI (toolbars, menus, hover, drag preview, per-block flags) → Effect-TS `SubscriptionRef`.
- Component-local UI → `useState` only if no second component reads it.

Reaching for Valtio, Zustand, or Jotai is foreclosed by [ADR 0006](adr/0006-ui-state-effect-over-valtio.md). If a UI need can't be expressed cleanly with `SubscriptionRef` + `PubSub`, raise an ADR before introducing a new state library.

## 6. Anti-patterns rejected in review

Surfaced for completeness; each is also called out in `CLAUDE.md`. Reviewers may block on these without further discussion:

- `result._tag === "X"` outside `Schedule.whileInput` / `Stream.filter` predicates → use `Match.tag` or `Effect.catchTag`.
- `switch (kind) { case ... }` over a `BlockKind` / `MarkKind` / domain literal union → use `Match.value(...).pipe(...)` per §1.
- `try { ... } catch { ... }` around an `Effect.runPromise` to recover from domain errors → recover **inside** the Effect with `catchTag`.
- `throw new Error(...)` inside `Effect.gen` / `flatMap` → `yield* Effect.fail(new TaggedError({...}))`.
- `Match.value(...).pipe(Match.tag(...))` without `Match.exhaustive` (or a justified `Match.orElse`) → add it; compile-time exhaustiveness is the whole point.
- `Effect.catchAll` when only one tag is expected → narrow to `catchTag` so unknown errors keep propagating.
- Introducing Valtio / Zustand / Jotai for ephemeral UI state → use `SubscriptionRef` (ADR 0006).

## 7. Tests follow the same idiom

Test files are application code too. Inside test bodies:

- Cast through the `future(editor)` helper (see `packages/core/tests/_test-helpers.ts`) when exercising APIs that the implementation hasn't shipped yet — that file is the typed forward-reference for what `@weaver/core` will expose.
- For tests that branch on tagged values (e.g. checking a `Cause` shape, asserting an error kind), prefer `Match` over `if (e._tag === ...)`. The same exhaustiveness benefit applies: when a new failure mode appears, the test fails to compile until it's accounted for.

## See also

- [`prd.md`](prd.md) — D3 (plugin contract via Effect Layers), D4 (UI state via `SubscriptionRef`).
- [`architecture.md`](architecture.md) §4 — "Effect-TS — where it shines, where it doesn't."
- [ADR 0006](adr/0006-ui-state-effect-over-valtio.md) — Effect-TS over Valtio for UI state.
- [`block-model.md`](block-model.md) §6 — state layering, where the UI surface sits in the stack.
- [`lexical-parity.md`](lexical-parity.md) — the parity catalog whose v1 ✅ rows are the bound on the surface area subject to these guidelines.
- Project `CLAUDE.md` — top-level Effect-TS programming section; this file is the spec-side companion that survives outside the harness.
