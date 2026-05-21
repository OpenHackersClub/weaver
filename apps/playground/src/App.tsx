import { useEffect, useMemo, useState } from "react";
import { getBlock, getChildren, rootId } from "@weaver/core";
import { EditorRoot, useEditor } from "@weaver/react";
import { EXAMPLES, seedExample, type ExampleId } from "./examples.js";
import { readUrlState, writeUrlState, type DebugPanelId } from "./url-state.js";
import { DebugPanels } from "./debug-panels.js";
import { createRuntime } from "./agents/runtime.js";
import { AgentsPanel } from "./agents/agents-panel.js";
import { PresenceLayer } from "./agents/presence-layer.js";

const ALL_DEBUG_PANELS: ReadonlyArray<DebugPanelId> = ["tree", "ops", "vv", "fps"];

/** Compact recursive view of the block tree — used by acceptance tests to
 *  assert structural nesting (which the flat DOM renderer can't reveal). */
export interface DebugTreeNode {
  readonly id: string;
  readonly kind: string | null;
  readonly children: ReadonlyArray<DebugTreeNode>;
}

const installDebugGlobals = (editor: ReturnType<typeof useEditor>) => {
  const w = window as unknown as {
    __weaver_debug?: {
      snapshot: () => unknown;
      blocksCount: () => number;
      version: () => unknown;
      tree: () => ReadonlyArray<DebugTreeNode>;
    };
  };
  const buildTree = (parentId: string): DebugTreeNode[] =>
    getChildren(editor, parentId).map((id) => ({
      id,
      kind: getBlock(editor, id)?.kind ?? null,
      children: buildTree(id),
    }));
  w.__weaver_debug = {
    snapshot: () => editor.doc.toJSON(),
    blocksCount: () =>
      Array.isArray(editor.tree.toJSON()) ? editor.tree.toJSON().length : 0,
    version: () => Object.fromEntries(editor.doc.version().toJSON()),
    tree: () => buildTree(rootId(editor)),
  };
};

export const App = () => {
  const initial = useMemo(() => readUrlState(window.location.search), []);
  const editor = useEditor({ origin: "user" });
  const [runtime] = useState(() => createRuntime(editor));
  const [example, setExample] = useState<ExampleId>(initial.example);
  const [debug, setDebug] = useState<ReadonlySet<DebugPanelId>>(initial.debug);
  const [theme, setTheme] = useState<"light" | "dark">(initial.theme);
  const [agents, setAgents] = useState<number>(initial.agents);

  const opLogEditors = useMemo(
    () => [editor, ...runtime.agentEditors()],
    [editor, runtime],
  );

  useEffect(() => {
    installDebugGlobals(editor);
  }, [editor]);

  useEffect(() => {
    return () => runtime.dispose();
  }, [runtime]);

  // Reseed the visitor's doc on example change. `reset` first stops every
  // agent and clears its internal state so the reseed starts from a clean
  // slate; the agent count is then (re)applied by the effect below.
  useEffect(() => {
    runtime.reset();
    seedExample(editor, example);
  }, [editor, runtime, example]);

  useEffect(() => {
    runtime.setCount(agents);
  }, [runtime, agents]);

  useEffect(() => {
    writeUrlState({ example, debug, theme, agents });
  }, [example, debug, theme, agents]);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  const chooseExample = (id: ExampleId): void => {
    setExample(id);
    // The "agent-collab" example ships with the Mock AI agents feature
    // pre-enabled (specs/playground.md §What it shows item 2).
    setAgents(id === "agent" ? 2 : 0);
  };

  const toggleDebug = (id: DebugPanelId): void => {
    setDebug((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>weaver playground</h1>
        <p className="tagline">
          A Notion-style block editor where AI agents are first-class CRDT peers.{" "}
          <a href="https://weaver.openhackers.club">docs</a>
        </p>
      </header>
      <div className="app-body">
        <nav className="sidebar">
          <section>
            <h2>Examples</h2>
            <ul className="example-list">
              {EXAMPLES.map((ex) => (
                <li key={ex.id}>
                  <button
                    type="button"
                    data-active={ex.id === example}
                    onClick={() => chooseExample(ex.id)}
                  >
                    {ex.label}
                  </button>
                  <p>{ex.description}</p>
                </li>
              ))}
            </ul>
          </section>
          <AgentsPanel runtime={runtime} />
          <section>
            <h2>Debug overlays</h2>
            <ul className="debug-list">
              {ALL_DEBUG_PANELS.map((id) => (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={debug.has(id)}
                      onChange={() => toggleDebug(id)}
                    />{" "}
                    {id}
                  </label>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Theme</h2>
            <button
              type="button"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? "Switch to dark" : "Switch to light"}
            </button>
          </section>
        </nav>
        <main className="surface">
          <EditorRoot editor={editor} className="editor" autoFocus />
          <PresenceLayer editor={editor} presence={runtime.presence} />
        </main>
        <DebugPanels editor={editor} opLogEditors={opLogEditors} enabled={debug} />
      </div>
      <footer className="app-footer">
        <p>
          Built on{" "}
          <a href="https://loro.dev" target="_blank" rel="noopener">
            Loro
          </a>{" "}
          + Effect-TS. Source:{" "}
          <a href="https://github.com/OpenHackersClub/weaver" target="_blank" rel="noopener">
            github.com/OpenHackersClub/weaver
          </a>
        </p>
      </footer>
    </div>
  );
};
