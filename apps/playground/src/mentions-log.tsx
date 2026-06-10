import { useEffect, useRef, useState } from "react";
import type { Editor } from "@weaver/core";

/** Trailing-debounce window for the demo's mention listener. */
export const MENTION_LOG_DEBOUNCE_MS = 500;
const MAX_ENTRIES = 20;

interface LogEntry {
  readonly key: number;
  readonly label: string;
  readonly principalId: string;
  readonly kind: string;
  readonly origin: string;
  readonly batchSize: number;
}

/**
 * Sidebar panel demonstrating the `MentionCreated` editor event. Subscribes
 * with a 500 ms trailing debounce — a burst of mentions arrives as ONE
 * batch — and mirrors each batch onto `window.__weaver_mention_batches` so
 * acceptance tests can assert the debounced delivery contract.
 */
export const MentionsLog = ({ editor }: { editor: Editor }) => {
  const [entries, setEntries] = useState<ReadonlyArray<LogEntry>>([]);
  const seq = useRef(0);

  useEffect(() => {
    const unsub = editor.events.on(
      "MentionCreated",
      (events) => {
        const w = window as unknown as {
          __weaver_mention_batches?: Array<
            Array<{ principalId: string; label: string; origin: string }>
          >;
        };
        w.__weaver_mention_batches ??= [];
        w.__weaver_mention_batches.push(
          events.map((e) => ({
            principalId: e.principal.id,
            label: e.principal.label,
            origin: String(e.origin),
          })),
        );
        setEntries((prev) => {
          const next = [...prev];
          for (const e of events) {
            next.push({
              key: seq.current++,
              label: e.principal.label,
              principalId: e.principal.id,
              kind: e.principal.kind ?? "user",
              origin: String(e.origin),
              batchSize: events.length,
            });
          }
          return next.slice(-MAX_ENTRIES);
        });
      },
      { debounceMs: MENTION_LOG_DEBOUNCE_MS },
    );
    return unsub;
  }, [editor]);

  return (
    <section data-mentions-log>
      <h2>Mentions</h2>
      {entries.length === 0 ? (
        <p className="mentions-log-empty">
          Type <code>@</code> in the editor to mention a person or agent. Events
          arrive here debounced ({MENTION_LOG_DEBOUNCE_MS} ms).
        </p>
      ) : (
        <ul className="mentions-log-list">
          {entries.map((e) => (
            <li key={e.key} data-mention-event data-principal-id={e.principalId}>
              <span className="mentions-log-label">{e.label}</span>
              <span className="mentions-log-meta">
                {e.kind} · by {e.origin}
                {e.batchSize > 1 ? ` · batch of ${e.batchSize}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
