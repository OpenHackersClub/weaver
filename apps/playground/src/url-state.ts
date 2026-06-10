import { EXAMPLES, type ExampleId } from "./examples.js";
import { MAX_AGENTS } from "./agents/runtime.js";

export type DebugPanelId = "tree" | "ops" | "vv" | "fps";

export interface UrlState {
  readonly example: ExampleId;
  readonly debug: ReadonlySet<DebugPanelId>;
  readonly theme: "light" | "dark";
  /** Number of mock AI agents to enable on load (0..MAX_AGENTS). */
  readonly agents: number;
  /**
   * Collab mode (`specs/presence.md` §Playground demo): WebSocket relay URL
   * (`?ws=ws://127.0.0.1:8787`), shared doc id, and which demo principal this
   * tab is. Collab is ON by default — in dev the default relay is the local
   * `dev:sync` server; prod builds default to `VITE_WEAVER_WS_URL` when set,
   * else stay single-user. `?ws=off` opts out explicitly.
   */
  readonly ws: string | null;
  readonly doc: string;
  readonly me: string | null;
}

const ALL_DEBUG: ReadonlySet<DebugPanelId> = new Set(["tree", "ops", "vv", "fps"]);
const DEFAULT_EXAMPLE: ExampleId = "demo";

/**
 * The relay every tab connects to when the URL doesn't say otherwise.
 * Acceptance tests run against `vite preview` (a prod build with no
 * `VITE_WEAVER_WS_URL`), so they stay single-user unless a spec passes `?ws=`.
 */
const DEFAULT_WS: string | null =
  (import.meta.env["VITE_WEAVER_WS_URL"] as string | undefined) ??
  (import.meta.env.DEV ? "ws://127.0.0.1:8787" : null);

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

  const rawWs = params.get("ws");
  const ws = rawWs === "off" ? null : (rawWs ?? DEFAULT_WS);
  const doc = params.get("doc") ?? "playground";
  const me = params.get("me");

  return { example, debug, theme, agents, ws, doc, me };
};

export const writeUrlState = (state: UrlState): void => {
  const params = new URLSearchParams();
  params.set("example", state.example);
  if (state.debug.size > 0) {
    params.set("debug", Array.from(state.debug).join(","));
  }
  if (state.theme === "dark") params.set("theme", "dark");
  if (state.agents > 0) params.set("agents", String(state.agents));
  if (state.ws !== null) {
    // The default relay stays out of the URL — only deviations are pinned.
    if (state.ws !== DEFAULT_WS) params.set("ws", state.ws);
    if (state.doc !== "playground") params.set("doc", state.doc);
    if (state.me !== null) params.set("me", state.me);
  } else if (DEFAULT_WS !== null) {
    // Collab would re-engage on reload unless the opt-out is made explicit.
    params.set("ws", "off");
  }
  const next = `?${params.toString()}`;
  if (window.location.search !== next) {
    window.history.replaceState({}, "", next);
  }
};
