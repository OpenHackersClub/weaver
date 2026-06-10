/**
 * Mock AI agent runtime — the headless half of the Playground's headline
 * feature (see `specs/playground.md` § Mock AI agents).
 *
 * Each mock agent is a *real CRDT peer*: a full `@weaver/core` `Editor` on its
 * own `LoroDoc`, wired to the visitor's editor by `connectPeers` (in-process
 * op forwarding — the demo transport short-circuit). An agent streams a canned
 * script of `LoroText.insert` ops marked `agent-pending`, publishes a moving
 * presence cursor, and — because it is a distinct peer — owns its own
 * `UndoManager`, so "reject" is just that agent peer's `history.undo()`.
 *
 * Per ADR 0007: the playback workflow is an interruptible Effect fiber, and
 * the ephemeral control state is an Effect `SubscriptionRef` consumed by React
 * through `useSubscriptionRef`.
 */
import { Duration, Effect, Fiber, SubscriptionRef } from "effect";
import {
  type Editor,
  type PeerLink,
  type PresenceHub,
  connectPeers,
  createEditor,
  createPresenceHub,
  getChildren,
  rootId,
} from "@weaver/core";
import {
  AGENT_SCRIPTS,
  DEFAULT_SCRIPT_FOR,
  type ScriptId,
  pickScriptForPrompt,
} from "./scripts.js";

/**
 * The demo agent roster. Ids follow the `agent-<name>` convention (mirrored in
 * `principals.ts` so a mention of an agent and its presence record read as the
 * same identity); colors are stable per agent and shared with the caret + op
 * chip tints.
 */
const AGENT_DIRECTORY: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly color: string;
}> = [
  { id: "agent-richard", label: "Agent Richard", color: "#e0245e" },
  { id: "agent-jared", label: "Agent Jared", color: "#1d9bf0" },
  { id: "agent-erlich", label: "Agent Erlich", color: "#17bf63" },
];

export const MAX_AGENTS = AGENT_DIRECTORY.length;
const DEFAULT_SPEED_MS = 220;
/**
 * Re-publish cadence keeping agent records alive on wire-connected hubs (45 s
 * eviction window) — same beat as `usePresence`'s human heartbeat.
 */
const AGENT_HEARTBEAT_MS = 15_000;

/** A single agent as the React UI sees it. */
export interface AgentView {
  readonly id: string; // "agent-richard"
  readonly index: number; // 1..MAX_AGENTS
  readonly label: string; // "Agent 1"
  readonly color: string;
  readonly running: boolean;
  readonly scriptId: ScriptId;
  readonly streamed: number; // chunks committed so far
  readonly total: number; // total chunks in the active script
}

export interface AgentsState {
  readonly count: number; // how many agents are active (0..MAX_AGENTS)
  readonly speedMs: number; // ms between streamed chunks
  readonly agents: ReadonlyArray<AgentView>;
}

export interface MockAgentRuntime {
  readonly state: SubscriptionRef.SubscriptionRef<AgentsState>;
  readonly presence: PresenceHub;
  /** The agent peer editors — handed to the op-log so it can show `origin`. */
  agentEditors(): ReadonlyArray<Editor>;
  setCount(n: number): void;
  toggle(id: string): void;
  start(id: string): void;
  stop(id: string): void;
  reject(id: string): void;
  setSpeed(ms: number): void;
  ask(prompt: string): void;
  /** Stop every agent and clear agent state — used when the doc is reseeded. */
  reset(): void;
  dispose(): void;
}

interface Agent {
  readonly index: number;
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly editor: Editor;
  scriptId: ScriptId;
  blockId: string | null;
  fiber: Fiber.RuntimeFiber<void, never> | null;
  streamed: number;
  /** True once the script has run to completion (stays "present" but idle). */
  done: boolean;
  /** Last published presence mode; `null` while not present in the hub. */
  mode: "generating" | "idle" | null;
}

export interface MockAgentRuntimeOptions {
  /**
   * Share an app-owned hub (collab mode) instead of creating a local one, so
   * agent presence rides the same wire as human presence and shows up in
   * remote tabs' facepiles/carets. A shared hub is NOT disposed by the
   * runtime — its creator owns teardown.
   */
  readonly presence?: PresenceHub;
}

export const createRuntime = (
  main: Editor,
  options: MockAgentRuntimeOptions = {},
): MockAgentRuntime => {
  const ownsHub = options.presence === undefined;
  const presence = options.presence ?? createPresenceHub();
  let speedMs = DEFAULT_SPEED_MS;

  // Presence store keys must be unique per session (`specs/presence.md`
  // §State layering): two collab tabs both running "agent-richard" publish two
  // records that dedupe to one facepile face via `principalId`.
  const session = Math.random().toString(36).slice(2, 8);

  const agents: Agent[] = [];
  for (let i = 1; i <= MAX_AGENTS; i++) {
    const entry = AGENT_DIRECTORY[i - 1]!;
    agents.push({
      index: i,
      id: entry.id,
      label: entry.label,
      color: entry.color,
      editor: createEditor({ origin: entry.id, seed: false }),
      scriptId: DEFAULT_SCRIPT_FOR[i]!,
      blockId: null,
      fiber: null,
      streamed: 0,
      done: false,
      mode: null,
    });
  }

  // One link over the visitor's editor + every agent peer. `connectPeers`
  // back-fills late joiners and is echo-free, so a single static link covers
  // the whole session regardless of how many agents are active at a time.
  const link: PeerLink = connectPeers(main, ...agents.map((a) => a.editor));

  const stateRef = Effect.runSync(
    SubscriptionRef.make<AgentsState>({
      count: 0,
      speedMs,
      agents: [],
    }),
  );
  let count = 0;

  const byId = (id: string): Agent | undefined =>
    agents.find((a) => a.id === id);

  const viewOf = (a: Agent): AgentView => ({
    id: a.id,
    index: a.index,
    label: a.label,
    color: a.color,
    running: a.fiber !== null,
    scriptId: a.scriptId,
    streamed: a.streamed,
    total: AGENT_SCRIPTS[a.scriptId].chunks.length + 1,
  });

  /** Push the current internal state into the `SubscriptionRef`. */
  const commitState = (): void => {
    const next: AgentsState = {
      count,
      speedMs,
      agents: agents.slice(0, count).map(viewOf),
    };
    Effect.runSync(SubscriptionRef.set(stateRef, next));
  };

  const peerIdOf = (a: Agent): string => `${a.id}#${session}`;

  const publishPresence = (a: Agent, mode: "generating" | "idle"): void => {
    if (a.blockId === null) return;
    a.mode = mode;
    presence.set({
      peerId: peerIdOf(a),
      principalId: a.id,
      label: a.label,
      color: a.color,
      kind: "agent",
      mode,
      cursor: {
        blockId: a.blockId,
        offset: a.editor.commands.text.length(a.blockId),
      },
    });
  };

  const removePresence = (a: Agent): void => {
    a.mode = null;
    presence.remove(peerIdOf(a));
  };

  // Without a beat, an idle-but-present agent would be reaped by a wire hub's
  // 45 s inactivity eviction mid-demo (the in-tab default hub never evicts).
  const heartbeat = setInterval(() => {
    for (const a of agents) {
      if (a.mode !== null) publishPresence(a, a.mode);
    }
  }, AGENT_HEARTBEAT_MS);

  /** Commit one streamed chunk into the agent's own block. */
  const streamChunk = (a: Agent, chunk: string): void => {
    const bid = a.blockId;
    if (bid === null) return;
    const start = a.editor.commands.text.length(bid);
    a.editor.commands.text.insert({ blockId: bid, offset: start, value: chunk });
    // Mark the freshly-inserted run `agent-pending`, valued with the agent id
    // so the renderer can tint per-agent (specs/ai-agent.md §5).
    a.editor.commands.text.mark.update({
      blockId: bid,
      range: { start, end: start + chunk.length },
      mark: "agent-pending",
      value: a.id,
    });
    a.streamed += 1;
    publishPresence(a, "generating");
    commitState();
  };

  const ensureBlock = (a: Agent): void => {
    if (a.blockId !== null) return;
    const root = rootId(a.editor);
    const index = getChildren(a.editor, root).length;
    a.blockId = a.editor.commands.block.insert({
      parentId: root,
      index,
      kind: "paragraph",
      attrs: {},
    });
  };

  /** The interruptible playback workflow for one agent (ADR 0007). */
  const runScript = (a: Agent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const script = AGENT_SCRIPTS[a.scriptId];
      // The leading chunk carries the agent's identity literal.
      const chunks = [`${a.id} · `, ...script.chunks];
      for (const chunk of chunks) {
        yield* Effect.sleep(Duration.millis(speedMs));
        yield* Effect.sync(() => streamChunk(a, chunk));
      }
      yield* Effect.sync(() => {
        a.done = true;
        a.fiber = null;
        publishPresence(a, "idle");
        commitState();
      });
    });

  const start = (id: string): void => {
    const a = byId(id);
    if (!a || a.fiber !== null) return;
    a.done = false;
    ensureBlock(a);
    publishPresence(a, "generating");
    a.fiber = Effect.runFork(runScript(a));
    commitState();
  };

  const stop = (id: string): void => {
    const a = byId(id);
    if (!a) return;
    if (a.fiber !== null) {
      Effect.runFork(Fiber.interrupt(a.fiber));
      a.fiber = null;
    }
    removePresence(a);
    commitState();
  };

  const reject = (id: string): void => {
    const a = byId(id);
    if (!a) return;
    if (a.fiber !== null) {
      Effect.runFork(Fiber.interrupt(a.fiber));
      a.fiber = null;
    }
    // Peer-scoped undo: the agent peer owns its `UndoManager`, so undoing
    // every step it took removes exactly this agent's contribution — Loro's
    // per-peer undo leaves the visitor's and other agents' edits untouched
    // (specs/ai-agent.md §5).
    let guard = 1000;
    while (a.editor.commands.history.canUndo() && guard-- > 0) {
      a.editor.commands.history.undo();
    }
    removePresence(a);
    a.blockId = null;
    a.streamed = 0;
    a.done = false;
    commitState();
  };

  const setCount = (n: number): void => {
    count = Math.max(0, Math.min(MAX_AGENTS, Math.floor(n)));
    for (const a of agents) {
      if (a.index <= count) {
        // Auto-start freshly-activated agents; leave already-running or
        // already-finished ones as the visitor left them.
        if (a.fiber === null && a.streamed === 0 && !a.done) start(a.id);
      } else {
        stop(a.id);
      }
    }
    commitState();
  };

  const toggle = (id: string): void => {
    const a = byId(id);
    if (!a) return;
    if (a.fiber !== null) stop(id);
    else start(id);
  };

  const setSpeed = (ms: number): void => {
    speedMs = Math.max(40, Math.min(2000, Math.floor(ms)));
    commitState();
  };

  const ask = (prompt: string): void => {
    const a = agents[0]!;
    a.scriptId = pickScriptForPrompt(prompt);
    if (count < 1) setCount(1);
    // Restart agent-1 so it replays the just-selected script.
    stop(a.id);
    a.blockId = null;
    a.streamed = 0;
    a.done = false;
    start(a.id);
    commitState();
  };

  const reset = (): void => {
    for (const a of agents) {
      if (a.fiber !== null) {
        Effect.runFork(Fiber.interrupt(a.fiber));
        a.fiber = null;
      }
      removePresence(a);
      // No undo here — the caller reseeds the doc, which clears every block.
      a.blockId = null;
      a.streamed = 0;
      a.done = false;
    }
    count = 0;
    commitState();
  };

  const dispose = (): void => {
    clearInterval(heartbeat);
    for (const a of agents) {
      if (a.fiber !== null) Effect.runFork(Fiber.interrupt(a.fiber));
    }
    link.dispose();
    if (ownsHub) presence.dispose();
    for (const a of agents) a.editor.dispose();
  };

  return {
    state: stateRef,
    presence,
    agentEditors: () => agents.map((a) => a.editor),
    setCount,
    toggle,
    start,
    stop,
    reject,
    setSpeed,
    ask,
    reset,
    dispose,
  };
};
