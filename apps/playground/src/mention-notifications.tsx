import { useEffect, useRef, useState } from "react";
import type { Editor } from "@weaver/core";

/** How long a notification toast stays on screen. */
export const MENTION_TOAST_TTL_MS = 6000;
const MAX_TOASTS = 5;

interface Toast {
  readonly key: number;
  readonly label: string;
  readonly principalId: string;
  readonly kind: string;
  readonly origin: string;
}

/**
 * Toast overlay demonstrating the *undebounced* side of the `MentionCreated`
 * contract: subscribing without `debounceMs` delivers every event
 * synchronously as a one-element batch, so each tag pops its own toast the
 * instant the chip lands. The sidebar `MentionsLog` subscribes to the same
 * events with a 500 ms trailing debounce — together the two panels showcase
 * both delivery modes of `editor.events.on`.
 */
export const MentionNotifications = ({ editor }: { editor: Editor }) => {
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
  const seq = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const unsub = editor.events.on("MentionCreated", (events) => {
      setToasts((prev) => {
        const next = [...prev];
        for (const e of events) {
          const key = seq.current++;
          next.push({
            key,
            label: e.principal.label,
            principalId: e.principal.id,
            kind: e.principal.kind ?? "user",
            origin: String(e.origin),
          });
          const timer = setTimeout(() => {
            timers.current.delete(timer);
            setToasts((cur) => cur.filter((t) => t.key !== key));
          }, MENTION_TOAST_TTL_MS);
          timers.current.add(timer);
        }
        return next.slice(-MAX_TOASTS);
      });
    });
    const pending = timers.current;
    return () => {
      unsub();
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, [editor]);

  if (toasts.length === 0) return null;
  return (
    <div className="mention-toasts" data-mention-notifications role="status">
      {toasts.map((t) => (
        <div
          key={t.key}
          className="mention-toast"
          data-mention-notification
          data-principal-id={t.principalId}
        >
          <span className="mention-toast-title">@{t.label} was notified</span>
          <span className="mention-toast-meta">
            {t.kind} · tagged by {t.origin}
          </span>
        </div>
      ))}
    </div>
  );
};
