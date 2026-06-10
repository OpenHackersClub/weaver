# Mentions — Tagging Principals In-Document

> Companion to [`block-model.md`](block-model.md) (mark storage, state layering) and [`ai-agent.md`](ai-agent.md) (agents as peers). Realizes the `TypeaheadMenuPlugin` row of [`lexical-parity.md`](lexical-parity.md) §1 as a Notion-style @-mention flow over the existing `mention` mark.

## What a mention is

A mention tags a **principal** — any identity addressable inside a document: a human collaborator or an AI agent peer. The `Principal` type lives in `@weaver/core` (`packages/core/src/principal.ts`):

| Field | Meaning |
|---|---|
| `id` | Stable identity, e.g. `user:ada`, `agent-1`. Same identifier space as access-control subjects (`access-control.md`) and presence `peerId`s. |
| `kind` | `"user"` \| `"agent"`. Agents are first-class mention targets — tagging `@Agent 1` reads the same as tagging a person. |
| `label` | Display name. |
| `color` / `avatarUrl` | Optional chip/menu hints. |

The persisted artifact is the existing **`mention` inline mark** (`expand: "none"`), valued `{ userId, label, kind? }` — `userId` predates `Principal` and is kept for storage compatibility; it holds `Principal.id` whatever the kind. The mark lives in LoroDoc, so mentions sync, merge, and undo like any other content (D1).

## The flow, layer by layer

```mermaid
sequenceDiagram
  participant U as User
  participant B as "@weaver/dom bridge"
  participant S as "SubscriptionRef&lt;MentionTrigger&gt;"
  participant M as "MentionMenu (@weaver/react)"
  participant C as "@weaver/core editor"
  participant L as App listener

  U->>B: types "@ad"
  B->>B: detectMentionTrigger(caret)
  B->>S: onMentionTrigger({query:"ad", rect})
  S->>M: menu opens, filtered to "ad"
  U->>M: Enter / click
  M->>C: text.insertMention({range, principal})
  C->>C: one commit: delete "@ad", insert "@Ada Lovelace " + mark
  C->>L: events.emit(MentionCreated) — debounced per subscriber
  C-->>B: doc.subscribe → reconcile, chip renders
```

- **Trigger detection** (`packages/dom/src/mention-trigger.ts`): an `@` at block start or after whitespace, with a whitespace-free query ≤ 40 chars between it and the collapsed caret. Mid-word `@` (emails) never triggers. The bridge re-evaluates after every input and on `selectionchange`, dedupes, and reports through `BridgeOptions.onMentionTrigger` — `null` dismisses.
- **Picker state is ephemeral UI** (ADR 0006): the active `MentionTrigger` lives in an Effect `SubscriptionRef` created by `useMentions` (`packages/react/src/mentions.tsx`); the highlighted row is component-local `useState`. Nothing about the open picker touches LoroDoc.
- **Insertion** (`text.insertMention`, `packages/core/src/editor.ts`): atomically replaces the trigger text with `@<label>` + one trailing space, marks the label, in **one commit / one undo step**. The directory of mentionable principals is app-provided (the editor never fetches).

## The event contract

`editor.events` (`packages/core/src/events.ts`) is the semantic notification channel — `doc.subscribe` says *what bytes changed*; `MentionCreated` says *someone was tagged*:

```ts
editor.events.on(
  "MentionCreated",
  (events) => notify(events), // ReadonlyArray<MentionCreatedEvent>
  { debounceMs: 500 },
);
```

- `MentionCreatedEvent` carries `blockId`, the marked `range`, the `principal`, and the `origin` of the editor that created it (`"user"`, `"agent-1"`, …).
- **Debounce is trailing and lossless**: events inside the window are buffered and delivered as one batch after `debounceMs` of quiet. No event is dropped — a burst of N mentions is one callback with N events. `debounceMs: 0`/omitted delivers synchronously, one event per batch.
- Programmatic mention application (`toggleMark` / `mark.update` with `mark: "mention"` — e.g. an agent tagging someone) emits the same event; toggling a mention **off** does not.
- Listeners are isolated: a throwing subscriber is logged and skipped — it can neither starve other subscribers nor propagate into the editor command that emitted.
- Scope note: the hub observes this editor's *commands*, not the CRDT — a mention merged in from a remote peer's sync update does not (yet) emit locally. Cross-peer mention notification belongs to the sync/notification layer and is future work.

## Known v1 limitations

- **Concurrent-edit guard, not transform.** `useMentions.insert()` revalidates that the text behind the trigger still equals `@query` before mutating; if a peer's edit shifted it, the picker closes instead of replacing the wrong range. Proper position stability across concurrent edits needs Loro `Cursor` anchors ([`hard-problems.md`](hard-problems.md) §1).
- **Trigger requires block start or whitespace before the `@`** — an emoji or punctuation immediately before it does not trigger (Notion is more permissive here). Full-width `＠` (U+FF20, JP input) is not a trigger character.
- **No live filtering during IME composition.** Trigger evaluation is suppressed while composing and re-runs on commit; the menu also ignores keys while a composition is active (`isComposing`).
- **Selection restore across reconciles is text-equality gated.** The bridge restores the caret over a re-rendered marked block only when that block's text is unchanged in the commit; offset transformation across remote text edits is the same Loro `Cursor` future work.

## Rendering

`@weaver/dom` renders the mark as `<span class="weaver-mention" data-mention-user-id data-mention-label data-mention-kind>`; styling is the host app's job (the Playground ships chip styles, tinted by `data-mention-kind`).

## Verification

- `packages/core/tests/events.test.ts` — debounce batching, unsubscribe, per-subscriber windows, command-path emission.
- `packages/core/tests/insert-mention.test.ts` — atomic replace/mark/undo semantics.
- `packages/dom/tests/mention-trigger.test.ts` — trigger scan rules + bridge lifecycle.
- `apps/playground/tests/acceptance/mentions.spec.ts` — full browser flow: open, filter, keyboard/click insert, debounced batch delivery.
