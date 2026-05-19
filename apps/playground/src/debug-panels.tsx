import { useEffect, useState } from "react";
import type { Editor } from "@weaver/core";
import { useDocSnapshot } from "@weaver/react";
import type { DebugPanelId } from "./url-state.js";

export interface OpEntry {
  readonly id: number;
  readonly origin: string;
  readonly by: string;
  readonly events: number;
  readonly target: string;
  readonly at: number;
}

/**
 * Recent Loro ops across the visitor's editor and every agent peer editor.
 *
 * Only `by === "local"` batches are recorded — each op then appears exactly
 * once, tagged with the originating peer's `origin` ("user", "agent-1", …).
 * (A commit's `origin` is event-local and is not carried across `import`, so
 * subscribing per-peer is how the op log recovers `origin: agent-N`.)
 */
export const useOpLog = (
  editors: ReadonlyArray<Editor>,
  limit = 60,
): ReadonlyArray<OpEntry> => {
  const [entries, setEntries] = useState<ReadonlyArray<OpEntry>>([]);
  useEffect(() => {
    let counter = 0;
    const unsubs = editors.map((editor) =>
      editor.doc.subscribe((batch) => {
        if (batch.by !== "local") return;
        counter += 1;
        const first = batch.events[0];
        const target = first ? String(first.target) : "";
        const entry: OpEntry = {
          id: counter,
          origin: batch.origin ?? "(none)",
          by: batch.by,
          events: batch.events.length,
          target,
          at: Date.now(),
        };
        setEntries((prev) => [entry, ...prev].slice(0, limit));
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [editors, limit]);
  return entries;
};

export const BlockTreePanel = ({ editor }: { editor: Editor }) => {
  const snapshot = useDocSnapshot(editor);
  return (
    <div className="debug-panel" data-weaver-debug-panel="tree">
      <header>Block tree</header>
      <pre>{JSON.stringify(snapshot, null, 2)}</pre>
    </div>
  );
};

export const OpLogPanel = ({
  editors,
}: {
  editors: ReadonlyArray<Editor>;
}) => {
  const ops = useOpLog(editors);
  return (
    <div className="debug-panel" data-weaver-debug-panel="ops">
      <header>Op log</header>
      <ol>
        {ops.map((op) => (
          <li key={op.id}>
            <span className="op-by">{op.by}</span>
            <span className="op-origin">origin={op.origin}</span>
            <span className="op-events">events={op.events}</span>
            <span className="op-target">target={op.target}</span>
          </li>
        ))}
      </ol>
    </div>
  );
};

export const VersionVectorPanel = ({ editor }: { editor: Editor }) => {
  const snapshot = useDocSnapshot(editor);
  // Touch snapshot so the panel re-renders on each commit.
  void snapshot;
  const vv = editor.doc.version();
  return (
    <div className="debug-panel" data-weaver-debug-panel="vv">
      <header>Version vector</header>
      <pre>{JSON.stringify(Object.fromEntries(vv.toJSON()), null, 2)}</pre>
    </div>
  );
};

export const DebugPanels = ({
  editor,
  opLogEditors,
  enabled,
}: {
  editor: Editor;
  /** The visitor's editor plus every agent peer editor — for the op log. */
  opLogEditors: ReadonlyArray<Editor>;
  enabled: ReadonlySet<DebugPanelId>;
}) => {
  if (enabled.size === 0) return null;
  return (
    <aside className="debug-stack">
      {enabled.has("tree") && <BlockTreePanel editor={editor} />}
      {enabled.has("ops") && <OpLogPanel editors={opLogEditors} />}
      {enabled.has("vv") && <VersionVectorPanel editor={editor} />}
    </aside>
  );
};
