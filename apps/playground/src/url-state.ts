import { EXAMPLES, type ExampleId } from "./examples.js";
import { MAX_AGENTS } from "./agents/runtime.js";

export type DebugPanelId = "tree" | "ops" | "vv" | "fps";

export interface UrlState {
  readonly example: ExampleId;
  readonly debug: ReadonlySet<DebugPanelId>;
  readonly theme: "light" | "dark";
  /** Number of mock AI agents to enable on load (0..MAX_AGENTS). */
  readonly agents: number;
}

const ALL_DEBUG: ReadonlySet<DebugPanelId> = new Set(["tree", "ops", "vv", "fps"]);
const DEFAULT_EXAMPLE: ExampleId = "demo";

export const readUrlState = (search: string): UrlState => {
  const params = new URLSearchParams(search);
  const rawExample = params.get("example");
  const example: ExampleId = EXAMPLES.some((e) => e.id === rawExample)
    ? (rawExample as ExampleId)
    : DEFAULT_EXAMPLE;
  const rawDebug = params.get("debug") ?? "";
  const debug: Set<DebugPanelId> = new Set();
  for (const part of rawDebug.split(",")) {
    const v = part.trim();
    if (ALL_DEBUG.has(v as DebugPanelId)) debug.add(v as DebugPanelId);
  }
  const theme: "light" | "dark" = params.get("theme") === "dark" ? "dark" : "light";

  // `?agents=<n>` is clamped to 0..MAX_AGENTS. When the param is absent the
  // `agent` example pre-enables the feature with 2 agents (specs/playground.md
  // § Mock AI agents); every other example defaults to 0.
  const rawAgents = params.get("agents");
  let agents: number;
  if (rawAgents !== null) {
    const parsed = Number.parseInt(rawAgents, 10);
    agents = Number.isNaN(parsed)
      ? 0
      : Math.max(0, Math.min(MAX_AGENTS, parsed));
  } else {
    agents = example === "agent" ? 2 : 0;
  }

  return { example, debug, theme, agents };
};

export const writeUrlState = (state: UrlState): void => {
  const params = new URLSearchParams();
  params.set("example", state.example);
  if (state.debug.size > 0) {
    params.set("debug", Array.from(state.debug).join(","));
  }
  if (state.theme === "dark") params.set("theme", "dark");
  if (state.agents > 0) params.set("agents", String(state.agents));
  const next = `?${params.toString()}`;
  if (window.location.search !== next) {
    window.history.replaceState({}, "", next);
  }
};
