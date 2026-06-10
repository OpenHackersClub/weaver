import type { Principal } from "@weaver/core";

/**
 * The demo's mentionable directory: a few human collaborators plus the three
 * mock AI agent peers (ids + colors match `agents/runtime.ts`, so a mention
 * of an agent and that agent's presence cursor read as the same identity).
 */
export const PLAYGROUND_PRINCIPALS: ReadonlyArray<Principal> = [
  { id: "user:ada", kind: "user", label: "Ada Lovelace", color: "#8b5cf6" },
  { id: "user:grace", kind: "user", label: "Grace Hopper", color: "#f59e0b" },
  { id: "user:linus", kind: "user", label: "Linus Torvalds", color: "#0ea5e9" },
  { id: "agent-1", kind: "agent", label: "Agent 1", color: "#e0245e" },
  { id: "agent-2", kind: "agent", label: "Agent 2", color: "#1d9bf0" },
  { id: "agent-3", kind: "agent", label: "Agent 3", color: "#17bf63" },
];
