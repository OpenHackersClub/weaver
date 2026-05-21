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

export interface FpsSample {
  /** FPS over the most recent ~500ms window. Meaningful only while `active`. */
  readonly fps: number;
  /** Lowest FPS across the rolling history of *active* windows. */
  readonly min: number;
  /** Mean FPS across the rolling history of *active* windows. */
  readonly avg: number;
  /** Whether the editor produced real rendering work during the last window.
   *  When false the rAF loop is only self-driving frames — see `useFps`. */
  readonly active: boolean;
  /** FPS values from recent *active* windows, oldest → newest, for the sparkline. */
  readonly history: ReadonlyArray<number>;
}

/** Window events that count as "the page is doing real rendering work." */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "scroll",
] as const satisfies ReadonlyArray<keyof WindowEventMap>;

/**
 * Samples frame timing via requestAnimationFrame and reports a windowed FPS.
 *
 * A naive rAF counter over-reports: the rAF loop *itself* keeps requesting
 * frames, so the browser renders at the full display refresh rate even when
 * the editor is idle — the panel reads ~60/120 while Chrome DevTools' Frame
 * Rendering Stats (which counts frames doing real work) shows ~0. To stay
 * aligned with DevTools, a window is only recorded as a sample when actual
 * rendering work occurred inside it: an input event (`ACTIVITY_EVENTS`) or a
 * LoroDoc commit. Idle windows surface as `active: false` rather than a
 * misleading number. Each window spans ~500ms for a stable, non-jittery read.
 */
export const useFps = (editor: Editor, windowSize = 60): FpsSample => {
  const [sample, setSample] = useState<FpsSample>({
    fps: 0,
    min: 0,
    avg: 0,
    active: false,
    history: [],
  });
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let lastActivity = 0;
    const history: number[] = [];

    const markActivity = (): void => {
      lastActivity = performance.now();
    };
    const listenerOpts: AddEventListenerOptions = {
      passive: true,
      capture: true,
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActivity, listenerOpts);
    }
    const unsubDoc = editor.doc.subscribe(markActivity);

    const tick = (now: number): void => {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 500) {
        // Active iff real rendering work landed somewhere inside this window.
        const active = now - lastActivity < elapsed;
        const fps = Math.round((frames * 1000) / elapsed);
        frames = 0;
        windowStart = now;
        if (active) {
          history.push(fps);
          if (history.length > windowSize) history.shift();
        }
        const min = history.length > 0 ? Math.min(...history) : 0;
        const avg =
          history.length > 0
            ? Math.round(
                history.reduce((sum, v) => sum + v, 0) / history.length,
              )
            : 0;
        setSample({ fps, min, avg, active, history: [...history] });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, markActivity, listenerOpts);
      }
      unsubDoc();
    };
  }, [editor, windowSize]);
  return sample;
};

/** Maps an FPS value to a coarse health bucket used for color cues. */
const fpsTier = (fps: number): "good" | "warn" | "bad" =>
  fps >= 55 ? "good" : fps >= 30 ? "warn" : "bad";

export const FpsPanel = ({ editor }: { editor: Editor }) => {
  const { fps, min, avg, active, history } = useFps(editor);
  return (
    <div className="debug-panel" data-weaver-debug-panel="fps">
      <header>FPS</header>
      <div className="fps-readout" data-active={active} data-weaver-fps>
        {active ? (
          <>
            <span className="fps-now" data-tier={fpsTier(fps)}>
              {fps}
            </span>
            <span className="fps-unit">fps</span>
          </>
        ) : (
          <span className="fps-idle">idle</span>
        )}
        <span className="fps-stat">avg {avg}</span>
        <span className="fps-stat">min {min}</span>
      </div>
      <div className="fps-spark" aria-hidden="true">
        {history.map((v, i) => (
          <span
            // History is a fixed-length sliding window; index is a stable key.
            key={i}
            className="fps-bar"
            data-tier={fpsTier(v)}
            style={{ height: `${Math.min(100, (v / 60) * 100)}%` }}
          />
        ))}
      </div>
      <p className="fps-hint">
        Sampled only while the editor renders — tracks DevTools Frame Rendering
        Stats, not the idle refresh rate.
      </p>
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
      {enabled.has("fps") && <FpsPanel editor={editor} />}
    </aside>
  );
};
