import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { Effect, Ref, SubscriptionRef } from "effect";
import type { Editor, Principal } from "@weaver/core";
import {
  type BridgeOptions,
  type MentionTrigger,
  placeCaret,
  reconcileTopLevel,
} from "@weaver/dom";
import { useSubscriptionRef } from "./use-subscription-ref.js";

/**
 * Notion-style @-mention wiring for an `EditorRoot`.
 *
 * The active trigger (`@quer|y` behind the caret) is ephemeral UI state, so
 * it lives in an Effect `SubscriptionRef` (ADR 0006) — never in LoroDoc. The
 * persisted artifact is the `mention` mark written by
 * `editor.commands.text.insertMention`, which also emits the `MentionCreated`
 * editor event apps can subscribe to (with optional debounce) via
 * `editor.events.on("MentionCreated", …)`.
 */
export interface MentionsApi {
  readonly editor: Editor;
  readonly principals: ReadonlyArray<Principal>;
  /** The active mention trigger, or `null` when the picker is closed. */
  readonly trigger: SubscriptionRef.SubscriptionRef<MentionTrigger | null>;
  /** Pass to `<EditorRoot bridgeOptions={…}>`. */
  readonly bridgeOptions: BridgeOptions;
  /** Pass to `<EditorRoot hostRef={…}>` so `insert` can restore the caret. */
  readonly hostRef: MutableRefObject<HTMLDivElement | null>;
  /** Replace the active trigger text with a mention of `principal`. */
  insert(principal: Principal): void;
  /** Dismiss the picker without inserting (Escape). */
  close(): void;
}

export interface UseMentionsOptions {
  readonly principals: ReadonlyArray<Principal>;
}

export const useMentions = (
  editor: Editor,
  options: UseMentionsOptions,
): MentionsApi => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const trigger = useMemo(
    () => Effect.runSync(SubscriptionRef.make<MentionTrigger | null>(null)),
    // A fresh editor gets a fresh picker cell.
    [editor],
  );

  const close = useCallback((): void => {
    Effect.runSync(Ref.set(trigger, null));
  }, [trigger]);

  const insert = useCallback(
    (principal: Principal): void => {
      const active = Effect.runSync(Ref.get(trigger));
      if (!active) return;
      // Revalidate before mutating: a remote peer's edit between trigger
      // capture and this click/Enter can shift or delete the trigger range —
      // captured offsets would then replace the wrong characters (or land
      // mid-codepoint and throw from Loro). Loro `Cursor` anchoring is the
      // long-term fix (specs/hard-problems.md); until then, bail and close
      // when the text behind the trigger no longer matches.
      const current = editor.commands.text
        .read(active.blockId)
        .slice(active.start, active.end);
      if (current !== `@${active.query}`) {
        close();
        return;
      }
      const marked = editor.commands.text.insertMention({
        blockId: active.blockId,
        range: { start: active.start, end: active.end },
        principal: {
          id: principal.id,
          label: principal.label,
          kind: principal.kind,
        },
      });
      // Reconcile synchronously and park the caret after the chip's trailing
      // space. The bridge's own (microtask) reconcile round-trips the live
      // selection through model offsets, so the caret survives it.
      const host = hostRef.current;
      if (host) {
        reconcileTopLevel(editor, host);
        placeCaret(host, { blockId: active.blockId, offset: marked.end + 1 });
      }
      close();
    },
    [editor, trigger, close],
  );

  const bridgeOptions = useMemo<BridgeOptions>(
    () => ({
      onMentionTrigger: (next) => {
        Effect.runSync(Ref.set(trigger, next));
      },
    }),
    [trigger],
  );

  return useMemo(
    () => ({
      editor,
      principals: options.principals,
      trigger,
      bridgeOptions,
      hostRef,
      insert,
      close,
    }),
    [editor, options.principals, trigger, bridgeOptions, insert, close],
  );
};

const identity = (t: MentionTrigger | null): MentionTrigger | null => t;

const matchesQuery = (principal: Principal, query: string): boolean => {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  return (
    principal.label.toLowerCase().includes(q) ||
    principal.id.toLowerCase().includes(q)
  );
};

export interface MentionMenuProps {
  readonly mentions: MentionsApi;
  readonly className?: string;
  /** Maximum number of suggestions rendered. Default 8. */
  readonly maxItems?: number;
}

/**
 * The floating typeahead menu. Renders only while a trigger is active;
 * anchors below the `@`; ArrowUp/Down to move, Enter/Tab to insert, Escape
 * to dismiss, click to insert. Key handling is capture-phase so the
 * contenteditable bridge never sees navigation keys while the menu is open.
 */
export const MentionMenu = ({
  mentions,
  className,
  maxItems = 8,
}: MentionMenuProps) => {
  const trigger = useSubscriptionRef(mentions.trigger, identity);
  const [selected, setSelected] = useState(0);
  const query = trigger?.query ?? "";

  const matches = useMemo(
    () =>
      mentions.principals
        .filter((p) => matchesQuery(p, query))
        .slice(0, maxItems),
    [mentions.principals, query, maxItems],
  );

  // A new trigger (or a narrowed query) resets the highlighted row.
  useEffect(() => {
    setSelected(0);
  }, [query, trigger?.blockId, trigger?.start]);

  useEffect(() => {
    if (!trigger) return;
    const onKeyDown = (ev: KeyboardEvent): void => {
      // Never steal keys from an active IME composition — Enter commits the
      // candidate, Escape cancels it, arrows navigate the candidate window.
      // (229 is the legacy "composition in progress" keyCode.)
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        ev.stopPropagation();
        setSelected((s) => Math.min(s + 1, Math.max(0, matches.length - 1)));
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        ev.stopPropagation();
        setSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        if (matches.length > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          const choice = matches[selected] ?? matches[0]!;
          mentions.insert(choice);
        } else {
          // "No matches": dismiss and let the key act on the editor —
          // otherwise Enter/Tab would visibly act "behind" an open menu.
          mentions.close();
        }
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        mentions.close();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [trigger, matches, selected, mentions]);

  if (!trigger) return null;

  const style: CSSProperties = trigger.rect
    ? {
        position: "fixed",
        left: trigger.rect.left,
        top: trigger.rect.bottom + 4,
      }
    : { position: "fixed", visibility: "hidden" };

  return (
    <div
      className={["weaver-mention-menu", className].filter(Boolean).join(" ")}
      style={style}
      role="listbox"
      aria-label="Mention a person or agent"
      data-mention-menu
    >
      {matches.length === 0 ? (
        <div className="weaver-mention-menu-empty">No matches</div>
      ) : (
        matches.map((p, i) => (
          <button
            type="button"
            key={p.id}
            role="option"
            aria-selected={i === selected}
            data-active={i === selected || undefined}
            data-principal-id={p.id}
            className="weaver-mention-menu-item"
            // preventDefault keeps focus (and the DOM selection) in the
            // editor so insert() can resolve the trigger range.
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => mentions.insert(p)}
            onMouseEnter={() => setSelected(i)}
          >
            {p.color ? (
              <span
                className="weaver-mention-menu-dot"
                style={{ background: p.color }}
                aria-hidden
              />
            ) : null}
            <span className="weaver-mention-menu-label">{p.label}</span>
            <span className="weaver-mention-menu-kind">{p.kind}</span>
          </button>
        ))
      )}
    </div>
  );
};
