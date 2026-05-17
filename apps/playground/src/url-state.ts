import { EXAMPLES, type ExampleId } from "./examples.js";

export type DebugPanelId = "tree" | "ops" | "vv";

export interface UrlState {
  readonly example: ExampleId;
  readonly debug: ReadonlySet<DebugPanelId>;
  readonly theme: "light" | "dark";
}

const ALL_DEBUG: ReadonlySet<DebugPanelId> = new Set(["tree", "ops", "vv"]);
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
  return { example, debug, theme };
};

export const writeUrlState = (state: UrlState): void => {
  const params = new URLSearchParams();
  params.set("example", state.example);
  if (state.debug.size > 0) {
    params.set("debug", Array.from(state.debug).join(","));
  }
  if (state.theme === "dark") params.set("theme", "dark");
  const next = `?${params.toString()}`;
  if (window.location.search !== next) {
    window.history.replaceState({}, "", next);
  }
};
