# Lexical Feature Parity — Catalog and Outcomes

> Status: spec only; implementation pending. This doc enumerates the Lexical features we explicitly commit to implementing, maps each to a weaver primitive, and defines the gradeable outcome that says "parity is shipped." The PRD non-goal (§5) "100% feature surface of Lexical day one" stands — this catalog is the **load-bearing subset** we *do* commit to, with each gap from full Lexical called out explicitly rather than silently omitted.

The reference is [Lexical's documentation](https://lexical.dev/docs) and the [lexical-playground](https://github.com/facebook/lexical/tree/main/packages/lexical-playground) feature set, surveyed as of 2026-05.

## How to read this catalog

Each row maps a Lexical primitive (node, plugin, command, hook) to one of three states:

| Status | Meaning |
|---|---|
| ✅ **In v1** | Shipped at parity; the row names the weaver equivalent. |
| 🔁 **In v1 via plugin** | Not in `@weaver/core`, but the v1 first-party plugin set covers it. |
| ⏳ **v2 / out of scope** | Deliberately deferred; the row says why. |

A reviewer should be able to read each row and confirm by pointing at the corresponding spec section or a follow-up issue.

## 1. Node / block kinds

Lexical's `node` is weaver's **block** (`LoroTreeNode` + `LoroMap` of typed attrs + optional `LoroText`; see [`block-model.md` §2](block-model.md)).

| Lexical node | weaver kind | Status | Notes |
|---|---|---|---|
| `RootNode` | (implicit; the `LoroTree` root) | ✅ | Not a user-visible block; structural. |
| `TabNode` | inline `	` (literal tab) inside `LoroText`, plus a `tab-indent` plugin (`@weaver/plugins-tab`) | 🔁 | Lexical ships `TabNode` + `LexicalTabIndentationPlugin`. We model the character in inline text; structural indent for lists uses `block.indent`/`block.outdent` directly. |
| `ParagraphNode` | `paragraph` | ✅ | Default block; markdown shortcut to other kinds. |
| `TextNode` (text leaves with format) | `LoroText` + marks | ✅ | Inline text is `LoroText`; format is CRDT `mark/unmark`. Lexical's "format bitmask" is encoded as overlapping marks. |
| `LineBreakNode` (soft break) | inline ` ` or `<br>` analog inside `LoroText` | ✅ | Soft break inside a text-bearing block. |
| `ElementNode` (custom container) | plugin-registered block kind with `children: true` | 🔁 | Plugins extend the kind catalog. |
| `DecoratorNode` (React-rendered atomic node) | block kind with `hasInline: false`, plugin-supplied React adapter | ✅ | E.g., `image`, `embed`, `divider`. |
| `HeadingNode` | `heading` (level 1–3 UI; 1–6 schema) | ✅ | |
| `QuoteNode` | `quote` | ✅ | Single-level only in v1. |
| `ListNode` (ul / ol) | `bullet-list-item`, `numbered-list-item` (nesting via tree children) | ✅ | Lexical models the list container as one node; weaver models each item as a block whose children are its nested items. Functionally equivalent. |
| `ListItemNode` | `bullet-list-item`, `numbered-list-item`, `to-do` | ✅ | |
| `CodeNode` | `code` block kind | ✅ | tree-sitter highlighting. |
| `CodeHighlightNode` | inline span emitted by tree-sitter highlighter | ✅ | Not a CRDT op; render-time decoration. |
| `LinkNode` | `link` mark | ✅ | weaver models link as a mark over `LoroText`, not a separate element. |
| `AutoLinkNode` | `link` mark + auto-linker plugin | 🔁 | Plugin detects URL-shaped runs and applies `link`. |
| `OverflowNode` (Lexical's character-limit affordance) | — | ⏳ | Deferred. Lexical ships `@lexical/overflow` + `LexicalCharacterLimitPlugin`; weaver plugins can implement equivalent behavior over `LoroText` length. |
| `HorizontalRuleNode` (already row above, but Lexical also exports `@lexical/react/LexicalHorizontalRuleNode`) | `divider` block kind | ✅ | Same block as `HorizontalRuleNode`; named separately for cross-ref. |
| `PageBreakNode` (playground) | `divider` with `pageBreak: true` attr **or** a future `page-break` plugin block kind | 🔁 | First-party Lexical playground node; deferred to a v1 plugin if requested. |
| Embed-shaped playground nodes — `FigmaNode`, `TweetNode`, `YouTubeNode`, `ExcalidrawNode` | `embed` block kind with allowlisted providers | 🔁 | These are Lexical playground demos showing how to register provider-specific embeds; weaver covers them through one polymorphic `embed` kind in v1. |
| `AutocompleteNode` (playground) | inline "agent-pending" preview rendered via `agent-pending` mark | 🔁 | Lexical's autocomplete is a custom node; weaver's equivalent is the agent-suggestion overlay (see `ai-agent.md`). |
| `MarkNode` (annotations) | `comment-anchor` mark | ✅ | weaver uses an internal mark to anchor comment threads; the comment payload itself lives in a sibling LoroDoc container. |
| `TableNode` / `TableRowNode` / `TableCellNode` | `table` / `table-row` / `table-cell` block kinds | ✅ | Block-table, not Database (see [ADR 0002](adr/0002-notion-style-block-model.md)). Fixed columns. |
| `HorizontalRuleNode` | `divider` | ✅ | |
| `ImageNode` (playground-only in Lexical) | `image` block kind | ✅ | OPFS cache + R2. |
| Custom `EmbedBlockNode` (e.g. YouTube, Twitter in playground) | `embed` block kind | ✅ | Allowlisted providers; iframe sandbox. |
| `HashtagNode` | inline plugin-registered span + `mention` analog | 🔁 | Lexical ships this as a published package (`@lexical/hashtag` + `LexicalHashtagPlugin`), not playground-only. v1 first-party set if demand exists; not core. |
| `KeywordNode` (playground) | — | ⏳ | Niche; not in v1. |
| `EmojiNode` (playground replacement) | — | 🔁 | Trivial plugin; OS emoji is the default. |
| `CollapsibleContainerNode` (toggle in `lexical-playground/src/plugins/CollapsiblePlugin/`) | `toggle` block kind | ✅ | Lexical's collapsible lives in the playground source, not a first-party `@lexical/*` package. |
| `LayoutContainerNode` / `LayoutItemNode` (multi-column in playground) | — | ⏳ | Multi-column layout not in v1; could be a plugin in v2. |
| `PollNode` / `StickyNode` / `EquationNode` (playground curiosities) | — | ⏳ | Demo-only in Lexical too; not committed for v1. |

## 2. Marks / inline formatting

Lexical encodes formatting as a bitmask on `TextNode`. weaver encodes it as overlapping CRDT marks on `LoroText` (see [`block-model.md` §3 "Marks shipped in v1"](block-model.md)).

| Lexical format | weaver mark | Status |
|---|---|---|
| `bold` | `bold` | ✅ |
| `italic` | `italic` | ✅ |
| `underline` | `underline` | ✅ |
| `strikethrough` | `strike` | ✅ |
| `code` (inline) | `code` (inline; cannot overlap `link`) | ✅ |
| `subscript` | — | 🔁 — plugin-supplied mark; not core. |
| `superscript` | — | 🔁 — plugin-supplied mark; not core. |
| `highlight` | `highlight` (`color` enum) | ✅ |
| Custom marks (e.g. comments) | `comment-anchor` (internal) | ✅ |

## 3. Commands & editor operations

Lexical's command bus is `editor.dispatchCommand(COMMAND, payload)`. weaver's command bus is the Effect-TS surface in `@weaver/core` (see [`architecture.md` §4](architecture.md#4-effect-ts--where-it-shines-where-it-doesnt)).

> The command symbols below (`text.*`, `block.*`, `selection.*`, `clipboard.*`) name the v1 command-bus surface. Their full enumeration belongs in a forthcoming `command-bus.md` spec; `block.*` structural commands are already defined in [`block-model.md` §3](block-model.md). Until `command-bus.md` lands, treat each row as a contract the future spec must keep.

| Lexical command (or capability) | weaver equivalent | Status |
|---|---|---|
| Text formatting (`FORMAT_TEXT_COMMAND`) | `text.toggleMark(blockId, range, markKind, attrs?)` | ✅ |
| Element formatting (`FORMAT_ELEMENT_COMMAND` — align) | `block.setAttr(blockId, "align", value)` for align-aware kinds | ✅ |
| Insert paragraph / line break | `block.split` / soft-break op | ✅ |
| Insert node at selection (`INSERT_…_COMMAND` family) | `block.insert(parentId, index, kind, attrs)` | ✅ |
| `INDENT_CONTENT_COMMAND` / `OUTDENT_CONTENT_COMMAND` | `block.indent(blockId)` / `block.outdent(blockId)` | ✅ |
| `INSERT_TAB_COMMAND` | `text.insertTab(blockId, offset)` (inserts a tab character; structural indent goes through `block.indent`) | ✅ |
| Remove text / nodes | `block.delete`, `text.delete` | ✅ |
| Undo / redo (`UNDO_COMMAND`, `REDO_COMMAND`) | Loro `UndoManager` peer-scoped by `origin` (see [ADR 0001](adr/0001-adopt-loro-over-yjs.md)) | ✅ |
| `CLEAR_HISTORY_COMMAND` | `editor.clearHistory()` — drops the `UndoManager` stack without touching the doc | ✅ |
| `CLEAR_EDITOR_COMMAND` | `editor.clear()` — replaces the LoroDoc content with the empty-doc template | ✅ |
| Selection ops (`SELECT_ALL_COMMAND` etc.) | weaver `selection.*` commands operating on `Cursor` anchors | ✅ |
| `SELECTION_CHANGE_COMMAND` (notification) | `useSelection()` hook ([`packages/react/src/use-editor-state.ts`](../packages/react/src/use-editor-state.ts)) subscribes via `editor.onSelectionChange`; no imperative bus event needed | ✅ |
| Keyboard (`KEY_*_COMMAND` family — arrows, enter, backspace, etc.) | core keymap in `@weaver/dom`; plugins register key handlers via the plugin contract | ✅ |
| Focus / blur (`FOCUS_COMMAND`, `BLUR_COMMAND`) | `editor.focus()` / `editor.blur()` on the surface | ✅ |
| Drag & drop (`DRAGSTART_COMMAND` / `DRAGOVER_COMMAND` / `DRAGEND_COMMAND` / `DROP_COMMAND`) | drag handle UI dispatches `block.move(blockId, newParentId, newIndex)` | ✅ |
| Clipboard (`COPY_COMMAND` / `CUT_COMMAND` / `PASTE_COMMAND`) | `clipboard.*` surface ([`packages/core/src/editor.ts`](../packages/core/src/editor.ts), DOM events in [`packages/dom/src/bridge.ts`](../packages/dom/src/bridge.ts)) — plain text + structured `application/x-weaver` JSON fragment (kinds, attrs, marks, nesting); HTML / Markdown codecs land with `@weaver/plugins-html` / `@weaver/plugins-markdown` | ✅ |
| `CAN_UNDO_COMMAND` / `CAN_REDO_COMMAND` introspection | `useUndoState()` hook ([`packages/react/src/use-editor-state.ts`](../packages/react/src/use-editor-state.ts)) | ✅ |
| Read-only mode | `editor.setEditable(false)` toggle, enforced on the surface by [`packages/dom/src/bridge.ts`](../packages/dom/src/bridge.ts) (`contenteditable` mirror + input guards) | ✅ |

## 4. Plugins (Lexical's first-party `@lexical/react` set)

Lexical ships ~30 packages under `@lexical/*`. weaver bundles equivalent behavior either into `@weaver/core` / `@weaver/react` or into the v1 first-party plugin set.

| Lexical plugin | weaver location | Status |
|---|---|---|
| `LexicalComposer` (root provider) | `<WeaverEditor>` React component | ✅ |
| `RichTextPlugin` / `PlainTextPlugin` | core; the editor is rich-text-only in v1 | ✅ |
| `HistoryPlugin` | core; backed by Loro `UndoManager` | ✅ |
| `AutoFocusPlugin` | option on `<WeaverEditor autoFocus>` | ✅ |
| `OnChangePlugin` | core hook `useOnDocChange` (subscribes to LoroDoc diffs, debounced) | ✅ |
| `MarkdownShortcutPlugin` | plugin in v1 first-party set (`@weaver/plugins-markdown`) | 🔁 |
| `ListPlugin` / `CheckListPlugin` | core; list kinds are built-in | ✅ |
| `LinkPlugin` / `ClickableLinkPlugin` / `AutoLinkPlugin` | plugin (`@weaver/plugins-link`) | 🔁 |
| `CodeHighlightPlugin` | core via tree-sitter for `code` blocks | ✅ |
| `TablePlugin` | core; `table` kind is built-in | ✅ |
| `EmojiPickerPlugin` | plugin (`@weaver/plugins-emoji`) | 🔁 |
| `TypeaheadMenuPlugin` (the underpinning Lexical actually ships; "MentionsPlugin" in the wild is a playground example built on top) | core; `mention` is a built-in inline **mark** (`{ userId, label, kind? }`, `expand: "none"`); trigger detection in `@weaver/dom`, typeahead menu UI in `@weaver/react` (`useMentions` + `MentionMenu`) — see `mentions.md` | ✅ |
| `HashtagPlugin` | plugin if needed | 🔁 |
| `DraggableBlockPlugin` (block handle drag) | core UI (`@weaver/react`'s drag handle) | ✅ |
| `FloatingTextFormatToolbarPlugin` (Lexical playground) | core UI (floating toolbar in `@weaver/react`) | ✅ |
| `HorizontalRulePlugin` (`@lexical/react`) | core; `divider` is a built-in block kind | ✅ |
| `TabIndentationPlugin` (`@lexical/react`) | core keymap for Tab / Shift-Tab → `block.indent` / `block.outdent` (structural) and `text.insertTab` (inline) | ✅ |
| `ClearEditorPlugin` | core; `editor.clear()` command | ✅ |
| `CharacterLimitPlugin` (`@lexical/react`, paired with `@lexical/overflow`) | — | ⏳ |
| `AutoEmbedPlugin` (Lexical playground) | plugin (`@weaver/plugins-embed`) — paste-URL → `embed` block | 🔁 |
| `@lexical/headless` (no-DOM editor for SSR / server-side) | — | ⏳ — server-side LoroDoc operates without a DOM today; a typed wrapper for "headless" use lands when there is a customer for it. |
| `SpeechToTextPlugin` | — | ⏳ |
| `CollaborationPlugin` from `@lexical/yjs` (shared-history pattern is documented atop this, not a separate first-party plugin) | core; CRDT collab is native, not a plugin (see [ADR 0001](adr/0001-adopt-loro-over-yjs.md)) | ✅ |
| `CommentPlugin` (playground) | core, anchored by `comment-anchor` mark; sibling LoroDoc container holds thread payloads | ✅ |
| `TableOfContentsPlugin` | derived from SQLite mirror outline (see [`wasm-strategy.md` §2.2](wasm-strategy.md)) | ✅ |
| `@lexical/markdown` (exposes transformers + `MarkdownShortcutPlugin`) | plugin (`@weaver/plugins-markdown`) covers transformers, import, and export | 🔁 |
| `HTML` import / export | plugin (`@weaver/plugins-html`) | 🔁 |
| `LayoutPlugin` (multi-column) | — | ⏳ |
| `PollPlugin` / `StickyPlugin` / `EquationPlugin` (playground demos) | — | ⏳ |

## 5. Hooks & React surface

| Lexical hook | weaver equivalent | Status |
|---|---|---|
| `useLexicalComposerContext()` | `useWeaverEditor()` returning the `EditorContext` | ✅ |
| `useLexicalCommand()` | `useCommand()` registering a typed handler against the command bus | ✅ |
| Selection hooks (`$getSelection`, `$createRangeSelection`, etc.) | `useSelection()` hook returning typed `Cursor` ranges; mutation via `selection.*` commands | ✅ |
| Node lookup (`$getNodeByKey`) | `useBlock(id)` / `findBlock(id)` | ✅ |
| `useEditable()` | option on `<WeaverEditor editable={...}>` + `useEditable()` reader | ✅ |

## 6. Serialization & import / export

| Lexical capability | weaver | Status |
|---|---|---|
| `editor.toJSON()` | `doc.exportSnapshot()` (Loro snapshot, binary) **and** `doc.toJSON()` (debug-friendly tree of `Block<K>`) | ✅ |
| HTML import / export | `@weaver/plugins-html` | 🔁 |
| Markdown import / export | `@weaver/plugins-markdown` | 🔁 |
| Custom serializer plugin API | plugin-registered serializer; visits the block tree | ✅ |

## 7. Architectural differences — *not* parity items

These are differences from Lexical we deliberately preserve, not gaps to close:

- **CRDT as the source of truth** (D1, [ADR 0001](adr/0001-adopt-loro-over-yjs.md)). Lexical holds an `EditorState` tree; collab is via `@lexical/yjs` syncing two states. weaver has one state.
- **No React-managed editing surface** ([`architecture.md` §1](architecture.md#1-system-overview)). Lexical's core (`lexical`) is framework-agnostic; its *common* binding is `@lexical/react` which puts the editing surface under React. weaver's surface is imperative DOM patched from Loro diffs.
- **Block-as-unit** ([ADR 0002](adr/0002-notion-style-block-model.md)). Lexical mixes block / inline / mark in one node type system. weaver makes the block a first-class primitive with separate inline/mark surfaces.
- **AI agents as peers, not API calls** ([`ai-agent.md`](ai-agent.md)). Lexical has no first-class agent model.
- **Effect-TS plugin contract**. Lexical plugin authoring is a set of editor registrations (`editor.registerCommand`, `editor.registerNodeTransform`, `editor.registerUpdateListener`) — the React layer is one binding atop those primitives. weaver plugins are Effect `Layer`s with typed error channels and exhaustive `Match.tag` pattern matching; the contract is structurally different, not just "React vs not-React."

Closing these would be re-becoming Lexical. They are not in the parity rubric.

## Outcome rubric

The Lexical-parity catalog is **delivered** when an independent grader, seeing only the implemented `@weaver/core` + `@weaver/react` + the v1 first-party plugin set, can mark each criterion below as binary pass/fail.

### Completeness
- Every row marked **✅ In v1** has a corresponding implementation that is reachable from a public export of `@weaver/core` or `@weaver/react`.
- Every row marked **🔁 In v1 via plugin** has a corresponding implementation in a published `@weaver/plugins-*` package.
- Every row marked **⏳** links to an open issue or RFC URL in the row's "Notes" column explaining the deferral; nothing in this column is implemented in v1; the grader can click each URL and reach a non-404 page.
- No ⏳ row's named primitive is reachable from the public exports of `@weaver/core` / `@weaver/react` / the published `@weaver/plugins-*` set. (Grader test: `grep` the public exports; no match.)
- The total count of ✅ + 🔁 rows in §1 (Node / block kinds) is **≥ 22**.
- The total count of ✅ + 🔁 rows in §2 (Marks) is **≥ 7**.
- The total count of ✅ + 🔁 rows in §3 (Commands) is **≥ 18**.
- The total count of ✅ + 🔁 rows in §4 (Plugins) is **≥ 20**.
- The total count of ✅ + 🔁 rows in §5 (Hooks) is **≥ 5**.
- The total count of ✅ + 🔁 rows in §6 (Serialization) is **≥ 4**.

### Fidelity
- For each ✅ block kind, applying the equivalent Lexical demo content (HTML or Markdown) via `@weaver/plugins-html` / `@weaver/plugins-markdown` produces a document whose serialized block tree (kind, depth, mark set per text run, link href, image src) equals Lexical's post-import tree under the documented normalizer in `@weaver/plugins-html/normalizer.ts` (tolerance: whitespace runs collapsed; element IDs ignored).
- For each ✅ command, dispatching the documented payload produces a post-command serialized block tree equal to Lexical's post-command tree, under the same normalizer, on the same input fixture.
- Undo / redo, after a sequence of N commands, returns `Loro.toJSON(doc)` to a value that `deep-equals` the snapshot taken before the sequence began (excluding container internal IDs).

### Traceability
- Each row in this catalog links to one of: the relevant code file, the relevant ADR, or an open issue (markdown URL).
- A lint script (`scripts/lint-parity-refs.ts`) exists and exits non-zero when a row's referenced file/URL does not resolve.
- The CI workflow `.github/workflows/ci.yml` invokes that lint script on any PR touching `specs/lexical-parity.md` (verifiable by an evaluator: induce a broken reference in a test PR; CI fails).

### Output quality
- The catalog is a single file (`specs/lexical-parity.md`) with §1–§7 in the documented order.
- Status icons (✅ 🔁 ⏳) appear exactly as listed in the legend; no ad-hoc statuses.
- Architectural differences (§7) are listed once and not interleaved with parity rows.

### Reproducibility
- The "render side-by-side" fidelity check is reproducible by a fresh contributor with the repo and a Lexical-playground clone; the steps are documented in this file's §"How to read this catalog" or in a sibling test-plan file.

## See also

- [`prd.md`](prd.md) — D1 (LoroDoc as single source of truth) and §5 non-goal "100% feature surface of Lexical day one" are the bedrock for this catalog.
- [`architecture.md`](architecture.md) — where the command bus, plugin contract, and reactivity model are defined.
- [`benchmarks.md`](benchmarks.md) — the perf bar this parity must clear.
- [`playground.md`](playground.md) — the demo surface that exercises the parity items.
- [`comparison.md`](comparison.md) — the narrative comparison (this file is the operational catalog).
- [Lexical docs](https://lexical.dev/docs/intro) and [lexical-playground](https://github.com/facebook/lexical/tree/main/packages/lexical-playground) — source of truth for what Lexical ships.
