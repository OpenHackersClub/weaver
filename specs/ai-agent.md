# weaver — AI Agent as a First-Class Citizen

> The differentiating capability of weaver. Companion to [`architecture.md`](architecture.md), [`hard-problems.md`](hard-problems.md), and [`access-control.md`](access-control.md).

## 1. The core idea

**AI agents are CRDT peers, not API clients.** An agent connects to a doc the same way a human does — over a WebSocket, holding a capability token, appearing as a presence record with a cursor. Its edits are real Loro ops, committed with `origin: agent-N`. Multi-agent and human↔agent concurrency are handled by the CRDT, not by special-case orchestration code.

The common pattern across editors today is **AI-as-API**: a generation call returns a blob of text, the user accepts it, the editor inserts it as a regular edit. weaver's agent is not an API call — it **is** a peer, with the same primitives as a human collaborator (cursor, presence, op stream, undo origin, scoped capability). See [`comparison.md`](comparison.md) for the side-by-side against named editors.

## 2. Three reinforcing capabilities

### 2.1 Agent as a LoroDoc peer

The agent runtime (a separate Cloudflare Worker or any other host) holds an attenuated Biscuit token, opens a WebSocket to the same DO the user is connected to, and applies ops. LLM token streams become `LoroText.insert` ops, each committed with `origin: agent-N`. The user sees text appear live. The user can keep typing mid-stream — Loro merges the concurrent edits. Multiple agents work the same way.

### 2.2 Presence + scoped cursors

Loro `EphemeralStore` carries presence records. Each agent's presence entry includes:

- agent identity (`agent:01H…`)
- scope range (the `Cursor` range the agent is currently working on)
- mode (`generating` / `idle` / `awaiting-tool-result`)
- color / icon hint for UI rendering

UI surfaces this as "Claude is rewriting paragraph 3" with a moving caret. User interrupt cancels the agent's Effect, agent stops at the next yield point.

### 2.3 Plugin-provided tools

Each plugin registers tools the agent can call: `bullet-list.toggle`, `table.add-row`, `math.insert-formula`, `embed.fetch-and-insert`. The agent's MCP-style catalog is the union of registered tools, **filtered by the agent's capability token** (server-enforced; see §4 below).

## 3. Effect-TS for agent workflows

Agents run as Effect-TS programs:

- **Tool calls** are typed `Effect`s with input/output schemas (Effect Schema).
- **Streaming** generation flows via `Stream<Token, ToolError>`; tokens are committed to Loro one at a time (or batched per LLM emit boundary).
- **Cancellation** is first-class — when the user takes over, the Effect is interrupted at the next yield; the agent stops mid-stream cleanly.
- **Retry / backoff** via `Schedule` for LLM rate limits and transient errors.
- **Telemetry** via spans — every tool invocation, every token batch, every Loro commit traced.

A representative agent workflow:

```ts
const rewriteBlock = (blockId: LoroTreeNodeId, instruction: string) =>
  Effect.gen(function* () {
    const block = yield* loadBlock(blockId);
    const context = yield* gatherContext(block);    // wa-sqlite mirror lookup (wasm-strategy.md §2.2)
    const stream = yield* llm.complete({
      system: ANTHROPIC_REWRITE_SYSTEM,
      messages: [{ role: "user", content: `${instruction}\n\n${context}` }],
    });
    yield* Stream.runForEach(stream, (token) =>
      loroPeer.commit(() => block.text.insert(token, { origin: agentId, marker: "agent-pending" })),
    );
  }).pipe(
    Effect.withSpan("agent.rewriteBlock", { attributes: { blockId, agentId } }),
    Effect.timeout("60 seconds"),
    Effect.catchTag("CardDeclined", () => Effect.fail(new ToolDeclined())),
  );
```

## 4. Agent access control

Agents are **first-class subjects**, not user extensions. See [`access-control.md` §11](access-control.md) for the full protocol.

1. User attenuates their own Biscuit token to produce an agent token with scoped caveats (`doc:X`, `subdoc-tags in [public, internal]`, `action in [read, comment, tool:text.rewrite]`, `time < 1h from now`).
2. Agent client receives the token; uses it for its WS upgrade.
3. DO enforces scope on every incoming op. Tool catalog returned to the agent is the intersection of registered tools and the agent's scope.
4. User can revoke the agent's token mid-session; DO closes the WS within seconds.

**Don't trust the agent client to enforce its own scope.** Tool catalog is the menu; DO is the bouncer.

## 5. Streaming UX — the marker pattern

Three options were considered for displaying in-progress agent generation ([`hard-problems.md` §5](hard-problems.md)). We chose **tagged origin + visible marker**:

- Agent edits go into the **main doc** (not a fork), with `origin: agent-N` carried natively in Loro change metadata.
- Inline content carries an `agent-pending` mark (one of the marks shipped in v1, see [ADR 0002](adr/0002-notion-style-block-model.md)).
- UI renders agent-pending content with a distinct visual (background tint, animated underline, or similar).
- User **accepts** the agent's edits by clearing the `agent-pending` mark (single Loro commit; mark removal). The content stays; the marker is gone.
- User **rejects** by issuing `UndoManager.undo({ origin: agent-N })` — Loro's peer-scoped undo removes exactly the agent's contribution without touching the user's concurrent edits.

Why not a fork branch? — see [`hard-problems.md` §5](hard-problems.md).

## 6. Multi-agent scenarios

Three agents work simultaneously, each on a different scope:

| Agent | Scope (`Cursor` range) | Tools |
|---|---|---|
| `agent:outline` | document root | `block.insert(heading)`, `block.move` |
| `agent:rewrite` | paragraph 5 | `text.rewrite`, `mark.toggle` |
| `agent:cite` | inline mentions | `mention.insert`, `embed.fetch` |

Their writes don't interfere (different `Cursor` ranges; CRDT merges trivially even on the rare cross-range op). Each appears in presence with its own color. The user supervises from a panel that shows each agent's mode and current scope.

If two agents target the same range, the CRDT still merges deterministically — no special orchestration needed. **This is the payoff of the peer model.**

## 7. Programmatic-write discipline

**Mandate:** every agent operation produces **minimal diffs**, never bulk delete-then-insert. See [`hard-problems.md` §9](hard-problems.md).

Naïve "rewrite this paragraph" → `delete all text, then insert new text` destroys cursors and concurrent edits. The agent runtime must:

- Compute the diff between old and new text (e.g. Myers diff via WASM).
- Apply only the minimal insert / delete ops needed.
- For style changes, apply mark toggles, never full re-insertions.

Property tests in Phase 3 verify: agent rewrites do not invalidate concurrent user cursor positions within the rewritten range.

## 8. AI streaming transport — separate channel from Loro RTC

Following the pattern from marimo's architecture: **AI tool-call traffic uses a separate channel from CRDT sync.** Specifically:

- AI completion / tool-call protocol: Vercel AI SDK SSE over `/api/ai/*`. Well-tooled, multi-provider, `@ai-sdk/react` hooks for the chat panel.
- Loro CRDT sync: WebSocket to the document Durable Object.

The agent runtime receives streaming tokens via the AI SDK transport, accumulates them, and **commits them to Loro as CRDT ops on the WS channel**. Two concerns; two channels. Easier to debug, easier to scale, no risk of CRDT-blocking on LLM latency.

## 9. Prompt audit (open question)

Every agent edit is in the [audit log](access-control.md) — server-rewritten origin, hash-chained, immutable on R2. But the **prompt that produced the edit** lives in the agent runtime, not the DO.

For compliance scenarios ("what did the agent do and why"), we need a separate prompt-audit log keyed by the same op IDs. Spec TBD; tracked in [`prd.md` §12 Open questions](prd.md).

## See also

- [`prd.md`](prd.md) — product vision, scope, roadmap
- [`architecture.md`](architecture.md) — system architecture (where the agent fits)
- [`hard-problems.md`](hard-problems.md) — streaming UX (§5), programmatic-write rule (§9)
- [`access-control.md`](access-control.md) — full agent-access-control protocol
- [`adr/0002-notion-style-block-model.md`](adr/0002-notion-style-block-model.md) — `agent-pending` mark, block kinds
- [`adr/0004-capability-token-format.md`](adr/0004-capability-token-format.md) — Biscuit attenuation for agent tokens
