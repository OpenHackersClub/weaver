import { useEffect, useRef, useState } from "react";
import { getBlock, type Editor } from "@weaver/core";

/**
 * Quiet window after the LAST edit to a tagged block before the intent is
 * captured. `MentionCreated` fires the moment the chip lands — usually
 * *before* the sentence around it is finished ("@Agent Richard what is our
 * latest spending?"), so reacting per-event would hand an LLM a truncated
 * question and toast on every keystroke. Instead the capture re-arms on every
 * subsequent edit to the block and fires only once typing has gone quiet.
 */
export const INTENT_QUIET_MS = 1500;
/** How long a captured-intent toast stays on screen. */
export const MENTION_TOAST_TTL_MS = 8000;
const MAX_TOASTS = 5;

interface Toast {
  readonly key: number;
  readonly label: string;
  readonly principalId: string;
  readonly kind: string;
  readonly origin: string;
  /** Block text after the mention chip, trimmed — the question for the LLM. */
  readonly question: string;
}

interface PendingMention {
  readonly principalId: string;
  readonly label: string;
  readonly kind: string;
  readonly origin: string;
  /** End of the mention label at insert time — the question starts here. */
  readonly rangeEnd: number;
}

interface PendingCapture {
  readonly blockId: string;
  mentions: PendingMention[];
  lastText: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface IntentMirror {
  readonly principalId: string;
  readonly label: string;
  readonly origin: string;
  readonly question: string;
  readonly blockText: string;
}

/**
 * Showcase consumer for `MentionCreated`: instead of reacting per-event, it
 * waits for the tagged block to go quiet (`INTENT_QUIET_MS` with no edits),
 * then reads the FULL block text and extracts everything after the chip as
 * the captured intent — what an app would actually send to an LLM. Each
 * capture is mirrored onto `window.__weaver_mention_intents` so acceptance
 * tests can assert the quiescence contract.
 */
export const MentionIntents = ({ editor }: { editor: Editor }) => {
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
  const seq = useRef(0);
  const toastTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const pending = new Map<string, PendingCapture>();

    const readText = (blockId: string): string | null => {
      if (!getBlock(editor, blockId)) return null;
      try {
        return editor.commands.text.read(blockId);
      } catch {
        return null;
      }
    };

    const finalize = (capture: PendingCapture): void => {
      const text = readText(capture.blockId);
      if (text === null) return; // block deleted mid-capture
      const w = window as unknown as {
        __weaver_mention_intents?: IntentMirror[];
      };
      w.__weaver_mention_intents ??= [];
      setToasts((prev) => {
        const next = [...prev];
        for (const m of capture.mentions) {
          const question = text.slice(m.rangeEnd).trim();
          w.__weaver_mention_intents!.push({
            principalId: m.principalId,
            label: m.label,
            origin: m.origin,
            question,
            blockText: text,
          });
          const key = seq.current++;
          next.push({
            key,
            label: m.label,
            principalId: m.principalId,
            kind: m.kind,
            origin: m.origin,
            question,
          });
          const timer = setTimeout(() => {
            toastTimers.current.delete(timer);
            setToasts((cur) => cur.filter((t) => t.key !== key));
          }, MENTION_TOAST_TTL_MS);
          toastTimers.current.add(timer);
        }
        return next.slice(-MAX_TOASTS);
      });
    };

    const rearm = (capture: PendingCapture): void => {
      if (capture.timer !== null) clearTimeout(capture.timer);
      capture.timer = setTimeout(() => {
        pending.delete(capture.blockId);
        finalize(capture);
      }, INTENT_QUIET_MS);
    };

    const unsubEvents = editor.events.on("MentionCreated", (events) => {
      for (const e of events) {
        const blockId = String(e.blockId);
        let capture = pending.get(blockId);
        if (!capture) {
          capture = { blockId, mentions: [], lastText: "", timer: null };
          pending.set(blockId, capture);
        }
        capture.mentions.push({
          principalId: e.principal.id,
          label: e.principal.label,
          kind: e.principal.kind ?? "user",
          origin: String(e.origin),
          rangeEnd: e.range.end,
        });
        capture.lastText = readText(blockId) ?? "";
        rearm(capture);
      }
    });

    // Any further edit to a tagged block re-arms its quiet timer — the
    // intent is the sentence the author finished, not the keystroke that
    // happened to follow the chip.
    const unsubDoc = editor.doc.subscribe(() => {
      for (const capture of pending.values()) {
        const text = readText(capture.blockId);
        if (text === null) continue; // finalize() guards deletion
        if (text !== capture.lastText) {
          capture.lastText = text;
          rearm(capture);
        }
      }
    });

    const timers = toastTimers.current;
    return () => {
      unsubEvents();
      unsubDoc();
      for (const capture of pending.values()) {
        if (capture.timer !== null) clearTimeout(capture.timer);
      }
      pending.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
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
          <span className="mention-toast-title">
            @{t.label} {t.question.length > 0 ? "was asked" : "was tagged"}
          </span>
          {t.question.length > 0 ? (
            <span className="mention-toast-question">“{t.question}”</span>
          ) : null}
          <span className="mention-toast-meta">
            {t.kind} · tagged by {t.origin} · captured after {INTENT_QUIET_MS}
            &thinsp;ms quiet
          </span>
        </div>
      ))}
    </div>
  );
};
