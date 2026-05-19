/**
 * Canned scripts for the Playground's Mock AI agents.
 *
 * "Mock" means scripted/deterministic, not LLM-backed (see
 * `specs/playground.md` § Mock AI agents): there is no model inference and no
 * `/api/ai/*` traffic. Each script is a list of text chunks; the runtime
 * streams one chunk per playback tick, committing each as a `LoroText.insert`
 * op marked `agent-pending`.
 */

export type ScriptId = "summary" | "review" | "citation";

export interface AgentScript {
  readonly id: ScriptId;
  readonly label: string;
  /**
   * Text chunks streamed one per playback tick. The runtime prepends a chunk
   * carrying the agent's id literal, so an agent's full contribution always
   * contains its `agent-N` identity (the Playground rubric relies on this).
   */
  readonly chunks: ReadonlyArray<string>;
}

export const AGENT_SCRIPTS: Record<ScriptId, AgentScript> = {
  summary: {
    id: "summary",
    label: "Summarize",
    chunks: [
      "This document ",
      "is backed by ",
      "a single LoroDoc ",
      "— the CRDT ",
      "source of truth.",
    ],
  },
  review: {
    id: "review",
    label: "Review",
    chunks: [
      "Every peer's ",
      "edits merge ",
      "deterministically, ",
      "so review never ",
      "blocks live typing.",
    ],
  },
  citation: {
    id: "citation",
    label: "Add citations",
    chunks: [
      "See the ",
      "access-control spec ",
      "for how subdocs ",
      "scope each block.",
    ],
  },
};

/** The script each agent index replays by default (1-based agent index). */
export const DEFAULT_SCRIPT_FOR: Record<number, ScriptId> = {
  1: "summary",
  2: "review",
  3: "citation",
};

/**
 * Map a free-text "ask" prompt to a canned script. This is the entire
 * intelligence of the mock "ask" panel — keyword routing, never an LLM call.
 */
export const pickScriptForPrompt = (prompt: string): ScriptId => {
  const p = prompt.toLowerCase();
  if (p.includes("review") || p.includes("check")) return "review";
  if (p.includes("cite") || p.includes("citation") || p.includes("source")) {
    return "citation";
  }
  return "summary";
};
