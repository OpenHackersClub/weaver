import { Match } from "effect";
import type { BlockId } from "./block.js";
import type { EditorOrigin } from "./editor.js";
import type { PrincipalKind } from "./principal.js";

/**
 * Typed editor events — the app-facing notification channel for semantic
 * editor moments (as opposed to raw Loro diffs from `doc.subscribe`, which
 * report *what bytes changed*, not *what the user did*).
 *
 * v1 carries a single event: a principal was mentioned. The union is shaped
 * for `Match.tag` so growing it (e.g. `LinkCreated`) is additive.
 */
export interface MentionCreatedEvent {
  readonly _tag: "MentionCreated";
  readonly blockId: BlockId;
  /** Character range of the mention label within the block's text. */
  readonly range: { readonly start: number; readonly end: number };
  readonly principal: {
    readonly id: string;
    readonly label: string;
    readonly kind?: PrincipalKind;
  };
  /** The editor origin that created the mention (`"user"`, `"agent-1"`, …). */
  readonly origin: EditorOrigin;
}

export type EditorEvent = MentionCreatedEvent;
export type EditorEventTag = EditorEvent["_tag"];

export interface EditorEventSubscribeOptions {
  /**
   * Trailing debounce window in milliseconds. Events arriving within the
   * window are buffered; the listener fires once with the whole batch after
   * the stream has been quiet for `debounceMs`. `0` / omitted delivers each
   * event synchronously as a one-element batch.
   */
  readonly debounceMs?: number;
}

export interface EditorEventHub {
  /** Publish an event to subscribers. Called by editor commands post-commit. */
  emit(event: EditorEvent): void;
  /**
   * Listen for events of one tag. Returns an unsubscribe function. With
   * `debounceMs`, delivery is batched trailing-debounce — no event is ever
   * dropped, only coalesced into a later batch.
   */
  on<K extends EditorEventTag>(
    tag: K,
    listener: (events: ReadonlyArray<Extract<EditorEvent, { _tag: K }>>) => void,
    options?: EditorEventSubscribeOptions,
  ): () => void;
  /** Cancel pending debounce timers and drop every subscription. */
  dispose(): void;
}

const tagOf = (event: EditorEvent): EditorEventTag =>
  Match.value(event).pipe(
    Match.tag("MentionCreated", () => "MentionCreated" as const),
    Match.exhaustive,
  );

interface Subscription {
  readonly listener: (events: ReadonlyArray<EditorEvent>) => void;
  readonly debounceMs: number;
  buffer: EditorEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

export const createEditorEventHub = (): EditorEventHub => {
  const subs = new Map<EditorEventTag, Set<Subscription>>();

  // Listener isolation: events are emitted from inside editor command bodies
  // (post-commit) and from timers. A throwing subscriber must neither starve
  // later subscribers nor propagate into the command / React handler that
  // triggered the emit — the doc mutation has already committed.
  const deliver = (
    sub: Subscription,
    batch: ReadonlyArray<EditorEvent>,
  ): void => {
    try {
      sub.listener(batch);
    } catch (err) {
      console.error("editor event listener threw", err);
    }
  };

  const flush = (sub: Subscription): void => {
    sub.timer = null;
    const batch = sub.buffer;
    sub.buffer = [];
    if (batch.length > 0) deliver(sub, batch);
  };

  return {
    emit: (event) => {
      const set = subs.get(tagOf(event));
      if (!set) return;
      // Snapshot: a synchronous listener may subscribe/unsubscribe during
      // delivery; new subscribers must not receive an event from before
      // their subscription.
      for (const sub of [...set]) {
        if (!set.has(sub)) continue; // unsubscribed by an earlier listener
        if (sub.debounceMs <= 0) {
          deliver(sub, [event]);
          continue;
        }
        sub.buffer.push(event);
        if (sub.timer !== null) clearTimeout(sub.timer);
        sub.timer = setTimeout(() => flush(sub), sub.debounceMs);
      }
    },

    on: (tag, listener, options) => {
      const sub: Subscription = {
        listener: listener as (events: ReadonlyArray<EditorEvent>) => void,
        debounceMs: options?.debounceMs ?? 0,
        buffer: [],
        timer: null,
      };
      let set = subs.get(tag);
      if (!set) {
        set = new Set();
        subs.set(tag, set);
      }
      set.add(sub);
      return () => {
        if (sub.timer !== null) clearTimeout(sub.timer);
        sub.timer = null;
        sub.buffer = [];
        set.delete(sub);
      };
    },

    dispose: () => {
      for (const set of subs.values()) {
        for (const sub of set) {
          if (sub.timer !== null) clearTimeout(sub.timer);
          sub.timer = null;
          sub.buffer = [];
        }
        set.clear();
      }
      subs.clear();
    },
  };
};
