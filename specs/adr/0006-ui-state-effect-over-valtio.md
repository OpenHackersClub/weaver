# ADR 0006 — UI State Store: Effect-TS `SubscriptionRef` over Valtio

- **Status:** Accepted
- **Date:** 2026-05-17
- **Renumbered:** 2026-05-18 — was ADR 0007; became 0006 when the former ADR 0005 (trust model) and ADR 0006 (AI agent threat model) were merged into [ADR 0005](./0005-trust-model.md).
- **Supersedes:** PRD decision D4 (was "Valtio holds UI-only state, never document state")
- **Relates to:** [`block-model.md` §6](../block-model.md), [`architecture.md` §3, §4](../architecture.md), [ADR 0001](./0001-adopt-loro-over-yjs.md), [ADR 0003](./0003-concurrent-semantics-no-global-rw-aw.md)

## Context

The original D4 chose Valtio for ephemeral UI state with the load-bearing rule "Valtio never holds document data; document data lives in LoroDoc." The rule still holds — it's not in question. What was in question was the *implementation* of the ephemeral-UI-state slot.

By the time the block model was specified ([`block-model.md` §6](../block-model.md)), the boundary layer of the architecture was already standardized on Effect-TS: plugin contract (Layer composition), sync orchestration, AI agent workflows, capability-token validation, command pipelines, the Schema-based op validator. Valtio was the only ephemeral-state primitive that wasn't part of the Effect graph.

That asymmetry created two costs we no longer want to pay:

1. **Two mental models in the boundary layer.** A plugin author writing a slash-command works in `Effect.gen` for the command path and in proxy mutations for the menu state. Same boundary, two idioms.
2. **State that can't compose with the rest of the graph.** Sequencing "open the AI panel → wait for the user's first draft → kick off an agent tool call" requires bridging Valtio events into Effect by hand. Same for "show a transient toast when sync reconnects" or "disable the toolbar while a plugin is loading." Each integration is bespoke glue.

The trigger to revisit was the architectural review captured in [`block-model.md` §6](../block-model.md) — the analysis there laid out the trade-offs, and the explicit conclusion was that Effect-TS could cover ~80% of Valtio's role naturally, with a small ergonomic cost on the remaining ~20% (per-block hover/focus, drag previews).

## Decision

**Drop Valtio. All ephemeral UI state lives in Effect-TS — `SubscriptionRef<T>` for observable cells, `PubSub<E>` for event broadcasts, `Layer` for store composition and injection, `Match.tag` for state machines, `Schema.TaggedStruct` / `Schema.Union` for state shapes.**

The unchanged primitives:

- **Document state** stays in LoroDoc (D1, ADR 0001).
- **Peer presence** stays in Loro `EphemeralStore` ([`access-control.md` §11](../access-control.md)).
- **Component-local state** can still use `useState` for genuinely local concerns (a tooltip's "is hovering right now" inside one component). The bar: if two components need to read it, it goes to a `SubscriptionRef`, not React Context.

What changes:

- Per-block UI state (hover, focus, locally-collapsed-just-for-me, comments-thread-expanded) lives in `SubscriptionRef` cells managed by a `BlockUiStore` service. The service owns a lazy map from `BlockId` to the per-block cell, created on first subscribe and disposed on unmount.
- Editor-wide UI state (slash menu, floating toolbar, drag preview, AI panel) lives in named `SubscriptionRef` cells on an `EditorUiStore` service.
- React subscribes via a single adapter hook: `useSubscriptionRef(ref, selector)`, bridging `Stream.changes` to `useSyncExternalStore`.

## Why Effect-TS

| Reason | What you get |
|---|---|
| **One mental model at the boundary** | Plugin code, sync code, AI workflows, UI state machines all use the same primitives (`Effect.gen`, `Match.tag`, `Layer`, tagged errors). Onboarding cost halves. |
| **State machines, not property bags** | A slash menu is `Closed \| Open { anchor, filter, highlight }`, not a `proxy({ open: false, filter: "", … })` with five truthy/falsy interaction rules. `Match.exhaustive` rejects new cases at compile time. |
| **Composability with the rest of the graph** | "Disable toolbar while a plugin loads," "open AI panel after sync reconnects," "kick off an agent tool call when the user accepts a suggestion" are all `Effect.gen` sequences across UI + sync + AI. No proxy↔Effect bridging glue. |
| **Layer injection** | Per-route, per-test, per-feature-flag store swaps are first-class. Mocking the AI panel state in a Storybook story is a Layer override, not a module mock. |
| **Schema-validated state** | Stored state can be encoded/decoded via the same Schema machinery used for op validation and capability tokens. Crash recovery / persisted UI prefs gain serializable shape. |
| **One library less** | Valtio is ~3 KB; the savings are minor. The non-trivial saving is *one fewer thing for plugin authors and contributors to learn*. |

## Costs we accept

1. **No proxy-level property tracking.** Selectors are explicit:
   ```ts
   const hovered = useSubscriptionRef(blockUi(id), s => s.hovered);
   ```
   Reading three fields means three selectors or one tuple-returning selector. Valtio's implicit "I read `state.hover`; re-render when `state.hover` changes" is gone.

2. **Per-event Effect overhead.** Every `pointermove` that updates hover state runs through `Ref.update` (Fiber bookkeeping). Profiled assumption: negligible for chrome paths at typical interaction rates. We commit to revisit (see Reversibility) if a profile says otherwise.

3. **~50–100 LOC of React adapter glue.** `useSubscriptionRef`, `useBlockUi(id)`, the lifecycle on `BlockUiStore.cellFor(id)`. Small, audited.

4. **The "just mutate the proxy" ergonomic is gone.** UI handlers write `Ref.update(ref, s => ...)` instead of `state.field = ...`. The cost is real and small; the benefit is type-safe state transitions.

## Why not alternatives

| Option | Why not |
|---|---|
| **Valtio** | The status-quo question; addressed above. Two mental models; no Effect composability; module-scope store makes Layer-injection tests harder. |
| **Zustand** | Smaller and simpler API than Valtio, but same architectural cost — a second state library outside the Effect graph. Wins nothing over Valtio for our case. |
| **Jotai** | Atom-based, fine-grained, well-loved. Same two-library cost. Adopting Jotai *and* Effect would be the strictly-worse version of choosing one. |
| **React Context + `useReducer`** | Re-renders the entire subtree on every dispatch. Slash-menu filter typing would flicker the editor surface. Also: no outside-React access — a keyboard handler in `@weaver/dom` (which is not React-managed) can't update Context state directly. |
| **Signals (TC39 proposal, Preact / Solid models)** | Standardization is still ongoing in 2026; React's interop story is not stable. Picking a non-standard signal library binds us to its specific dialect for v1; revisit after TC39 lands. |
| **Plain `useSyncExternalStore` over a hand-rolled emitter** | Equivalent in capability; we'd be reinventing `SubscriptionRef` with less type safety and no `Effect`/`Layer` integration. |

## What this changes about earlier decisions

- **PRD D4** is rephrased to: "All ephemeral UI state lives in Effect-TS `SubscriptionRef` cells composed via `Layer`. Document state remains in LoroDoc (D1); peer presence in Loro `EphemeralStore`."
- **`block-model.md` §6** is rewritten with the Effect-TS shape: `EditorUiStore` and `BlockUiStore` services, the `useSubscriptionRef` adapter, the two-collapse-states worked example using `Ref.update`.
- **`architecture.md` §3** layering table changes "Valtio" → "Effect-TS `SubscriptionRef`" in the UI-ephemeral row, and the §4 Effect-TS section gains "UI ephemeral state" to its "use it for" column.
- **`wasm-strategy.md`** updates the line about microtask-coalesced Valtio subscriptions to the equivalent Effect `Stream` pattern.
- **`README.md`** drops Valtio from the stack list. Effect-TS is now responsible for both boundary effects and UI state.

## Consequences

### Immediate

- Specs updated (above).
- Sample `EditorUiStore` and `BlockUiStore` shapes live in [`block-model.md` §6](../block-model.md) and are normative for Phase 0.
- No Valtio dependency in `package.json` (would not have been added yet — this ADR forecloses it).

### Downstream

- Plugin contract documentation can describe one effects model, not two. Plugin templates ship with `Effect.Service` examples for any plugin-owned UI state.
- Testing strategy: UI state machines test via `Layer` overrides; pure transitions test via `Effect.runPromise(...)` against the store; React-layer tests use the adapter with a test `Layer`.
- The state-machine discipline means new UI surfaces (mention picker, link editor, image upload progress, AI suggestion review) start as `Schema.Union` tagged states, not as accreting boolean flags.

### Reversibility

- The store API surface is small (`SubscriptionRef.{get,set,update,changes}`, `Layer.provide`). A future swap to a different reactivity primitive is mostly a per-file mechanical change.
- If per-event overhead becomes a measured problem on a hot UI path (profiled, not guessed), we can introduce a Valtio-flavored fast path for *that specific store* behind a feature flag without re-litigating the whole decision. The bar for that change is: "We have a profile showing >1ms of cumulative `Ref.update` time per frame on a realistic interaction trace."
- We commit to revisit this ADR if:
  1. A profile shows UI-state churn is a measurable bottleneck and a Valtio-shaped alternative would meaningfully recover the budget.
  2. The TC39 Signals proposal stabilizes and React-Signals interop is ergonomic, at which point the whole "fine-grained ephemeral state" problem may have a standard answer.

### Risks

- **Boilerplate fatigue.** Plugin authors writing `Effect.gen` for a hover indicator may grumble. Mitigation: ship a small set of helpers (`makeBoolean()`, `makeRecord(schema)`, `makeStateMachine(union)`) so the common cases are one-liners.
- **Per-block store lifecycle correctness.** Lazy creation + disposal on unmount is easy to get subtly wrong (leak the map; or dispose while another subscriber still cares). Mitigation: the `BlockUiStore` ships with a reference-counted cell-lifetime test suite from Phase 0.
- **`useSyncExternalStore` + `Stream` bridging.** Two reactivity models meeting; subtle correctness around tearing, batching, suspense. Mitigation: one canonical adapter (`useSubscriptionRef`), audited, used everywhere.

## Implementation sketch

```ts
// @weaver/react/state/editor-ui.ts
import { Effect, Layer, SubscriptionRef, Ref, Schema, Match } from "effect";

export const SlashMenu = Schema.Union(
  Schema.TaggedStruct("Closed", {}),
  Schema.TaggedStruct("Open", {
    anchor: BlockIdSchema,
    filter: Schema.String,
    highlight: Schema.Number,
  }),
);
export type SlashMenu = Schema.Schema.Type<typeof SlashMenu>;

export class EditorUiStore extends Effect.Service<EditorUiStore>()(
  "EditorUiStore",
  {
    effect: Effect.gen(function* () {
      const slashMenu = yield* SubscriptionRef.make<SlashMenu>({ _tag: "Closed" });
      const toolbar   = yield* SubscriptionRef.make<ToolbarState>(initialToolbar);
      const aiPanel   = yield* SubscriptionRef.make<AiPanelState>(initialAi);
      const drag      = yield* SubscriptionRef.make<DragState>({ _tag: "Idle" });
      return { slashMenu, toolbar, aiPanel, drag };
    }),
  },
) {}

// Per-block ephemera, lazily allocated.
export class BlockUiStore extends Effect.Service<BlockUiStore>()(
  "BlockUiStore",
  {
    effect: Effect.gen(function* () {
      const cells = new Map<BlockId, SubscriptionRef.SubscriptionRef<BlockUi>>();
      const cellFor = (id: BlockId) =>
        Effect.sync(() => {
          let c = cells.get(id);
          if (!c) {
            c = Effect.runSync(SubscriptionRef.make<BlockUi>(initialBlockUi));
            cells.set(id, c);
          }
          return c;
        });
      const dispose = (id: BlockId) => Effect.sync(() => { cells.delete(id); });
      return { cellFor, dispose };
    }),
  },
) {}
```

State transitions become exhaustive:

```ts
const openSlashMenu = (anchor: BlockId) =>
  Effect.gen(function* () {
    const { slashMenu } = yield* EditorUiStore;
    yield* Ref.set(slashMenu, { _tag: "Open", anchor, filter: "", highlight: 0 });
  });

const handleSlashKey = (ev: KeyboardEvent) =>
  Effect.gen(function* () {
    const { slashMenu } = yield* EditorUiStore;
    const current = yield* Ref.get(slashMenu);
    yield* Match.value(current).pipe(
      Match.tag("Closed", () => Effect.unit),
      Match.tag("Open", ({ filter, highlight }) =>
        Match.value(ev.key).pipe(
          Match.when("Escape", () => Ref.set(slashMenu, { _tag: "Closed" })),
          Match.when("ArrowDown", () =>
            Ref.update(slashMenu, (s) =>
              s._tag === "Open" ? { ...s, highlight: s.highlight + 1 } : s,
            ),
          ),
          Match.orElse(() => Effect.unit),
        ),
      ),
      Match.exhaustive,
    );
  });
```

React adapter:

```ts
// @weaver/react/use-subscription-ref.ts
export function useSubscriptionRef<T, S>(
  ref: SubscriptionRef.SubscriptionRef<T>,
  select: (t: T) => S,
  eq: (a: S, b: S) => boolean = Object.is,
): S {
  return useSyncExternalStore(
    useCallback((onChange) => {
      const fiber = Effect.runFork(
        ref.changes.pipe(
          Stream.map(select),
          Stream.changesWith(eq),
          Stream.runForEach(() => Effect.sync(onChange)),
        ),
      );
      return () => { Effect.runFork(Fiber.interrupt(fiber)); };
    }, [ref, select, eq]),
    () => select(Effect.runSync(Ref.get(ref))),
  );
}
```

## References

- [`block-model.md` §6](../block-model.md) — the canonical implementation spec for ephemeral UI state.
- [ADR 0001 — Loro over Y.js](./0001-adopt-loro-over-yjs.md) — D1 (LoroDoc is the single source of truth) is unchanged.
- [Effect-TS SubscriptionRef](https://effect.website/docs/concurrency/subscription-ref/) — reactive primitive.
- [Effect-TS Layer](https://effect.website/docs/requirements-management/layers/) — store composition and injection.
- [Effect-TS Match](https://effect.website/docs/code-style/pattern-matching/) — exhaustive state-machine pattern matching.
