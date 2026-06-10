/**
 * Editor event hub — semantic events with optional trailing-debounce
 * delivery (`specs/mentions.md` §events). The debounce contract: events are
 * never dropped, only coalesced; the listener fires once with the whole
 * batch after `debounceMs` of quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEditor,
  createEditorEventHub,
  getChildren,
  rootId,
  type MentionCreatedEvent,
} from "../src/index.js";

const mentionEvent = (
  overrides: Partial<Omit<MentionCreatedEvent, "_tag">> = {},
): MentionCreatedEvent => ({
  _tag: "MentionCreated",
  blockId: "1@0",
  range: { start: 0, end: 4 },
  principal: { id: "user:ada", label: "@Ada", kind: "user" },
  origin: "user",
  ...overrides,
});

describe("@weaver/core / events / hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers each event synchronously as a one-element batch by default", () => {
    const hub = createEditorEventHub();
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    hub.on("MentionCreated", (events) => seen.push(events));
    hub.emit(mentionEvent());
    hub.emit(mentionEvent({ principal: { id: "agent-1", label: "@Agent 1" } }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(1);
    expect(seen[1]![0]!.principal.id).toBe("agent-1");
  });

  it("debounces: a burst inside the window arrives as ONE batch, no drops", () => {
    const hub = createEditorEventHub();
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    hub.on("MentionCreated", (events) => seen.push(events), {
      debounceMs: 200,
    });

    hub.emit(mentionEvent({ principal: { id: "p-1", label: "@one" } }));
    vi.advanceTimersByTime(100); // inside the window — timer resets
    hub.emit(mentionEvent({ principal: { id: "p-2", label: "@two" } }));
    vi.advanceTimersByTime(199); // still quiet < debounceMs after last emit
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(1); // 200ms of quiet reached
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((e) => e.principal.id)).toEqual(["p-1", "p-2"]);
  });

  it("a second burst after a flush produces a second batch", () => {
    const hub = createEditorEventHub();
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    hub.on("MentionCreated", (events) => seen.push(events), {
      debounceMs: 50,
    });
    hub.emit(mentionEvent({ principal: { id: "p-1", label: "@one" } }));
    vi.advanceTimersByTime(50);
    hub.emit(mentionEvent({ principal: { id: "p-2", label: "@two" } }));
    vi.advanceTimersByTime(50);
    expect(seen).toHaveLength(2);
    expect(seen[0]![0]!.principal.id).toBe("p-1");
    expect(seen[1]![0]!.principal.id).toBe("p-2");
  });

  it("unsubscribe cancels a pending debounce flush", () => {
    const hub = createEditorEventHub();
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    const unsub = hub.on("MentionCreated", (events) => seen.push(events), {
      debounceMs: 100,
    });
    hub.emit(mentionEvent());
    unsub();
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(0);
  });

  it("dispose drops every subscription and pending timer", () => {
    const hub = createEditorEventHub();
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    hub.on("MentionCreated", (events) => seen.push(events), {
      debounceMs: 100,
    });
    hub.emit(mentionEvent());
    hub.dispose();
    vi.advanceTimersByTime(500);
    hub.emit(mentionEvent());
    expect(seen).toHaveLength(0);
  });

  it("a throwing listener neither starves later subscribers nor loses its own later batches", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hub = createEditorEventHub();
      const seen: MentionCreatedEvent[] = [];
      hub.on("MentionCreated", () => {
        throw new Error("listener bug");
      });
      hub.on("MentionCreated", (events) => seen.push(...events));
      expect(() => hub.emit(mentionEvent())).not.toThrow();
      expect(seen).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throwing debounced listener does not crash the flush timer or later windows", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hub = createEditorEventHub();
      let calls = 0;
      hub.on(
        "MentionCreated",
        () => {
          calls += 1;
          if (calls === 1) throw new Error("listener bug");
        },
        { debounceMs: 50 },
      );
      hub.emit(mentionEvent());
      expect(() => vi.advanceTimersByTime(50)).not.toThrow();
      hub.emit(mentionEvent());
      vi.advanceTimersByTime(50);
      expect(calls).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a listener subscribing during delivery does not receive the in-flight event", () => {
    const hub = createEditorEventHub();
    const late: MentionCreatedEvent[] = [];
    hub.on("MentionCreated", () => {
      hub.on("MentionCreated", (events) => late.push(...events));
    });
    hub.emit(mentionEvent());
    expect(late).toHaveLength(0);
    hub.emit(mentionEvent());
    expect(late).toHaveLength(1);
  });

  it("independent subscribers get independent debounce windows", () => {
    const hub = createEditorEventHub();
    const fast: ReadonlyArray<MentionCreatedEvent>[] = [];
    const slow: ReadonlyArray<MentionCreatedEvent>[] = [];
    hub.on("MentionCreated", (e) => fast.push(e)); // sync
    hub.on("MentionCreated", (e) => slow.push(e), { debounceMs: 300 });
    hub.emit(mentionEvent());
    expect(fast).toHaveLength(1);
    expect(slow).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(slow).toHaveLength(1);
  });
});

describe("@weaver/core / events / editor integration", () => {
  it("toggleMark applying a mention emits MentionCreated; toggle-off does not", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "hi @ada" });
    const seen: ReadonlyArray<MentionCreatedEvent>[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(events));

    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
      value: { userId: "user:ada", label: "@ada" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toMatchObject({
      blockId: id,
      range: { start: 3, end: 7 },
      principal: { id: "user:ada", label: "@ada" },
      origin: "user",
    });

    // Toggling the same fully-covered range OFF must not emit.
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 3, end: 7 },
      mark: "mention",
    });
    expect(seen).toHaveLength(1);
  });

  it("mark.update with a mention emits, carrying the editor origin", () => {
    const editor = createEditor({ origin: "agent-1" });
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "ping @ada" });
    const seen: MentionCreatedEvent[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(...events));
    editor.commands.text.mark.update({
      blockId: id,
      range: { start: 5, end: 9 },
      mark: "mention",
      value: { userId: "user:ada", label: "@ada", kind: "user" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.origin).toBe("agent-1");
    expect(seen[0]!.principal.kind).toBe("user");
  });

  it("mark.update on a missing block writes nothing and emits nothing", () => {
    const editor = createEditor();
    const seen: MentionCreatedEvent[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(...events));
    editor.commands.text.mark.update({
      blockId: "999@99999",
      range: { start: 0, end: 4 },
      mark: "mention",
      value: { userId: "user:ada", label: "@ada" },
    });
    expect(seen).toHaveLength(0);
  });

  it("a listener throwing does not escape the emitting command", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const editor = createEditor();
      const id = getChildren(editor, rootId(editor))[0]!;
      editor.events.on("MentionCreated", () => {
        throw new Error("listener bug");
      });
      expect(() =>
        editor.commands.text.insertMention({
          blockId: id,
          range: { start: 0, end: 0 },
          principal: { id: "user:ada", label: "Ada" },
        }),
      ).not.toThrow();
      // The mutation itself committed despite the listener bug.
      expect(editor.commands.text.read(id)).toBe("@Ada ");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("non-mention marks never emit MentionCreated", () => {
    const editor = createEditor();
    const id = getChildren(editor, rootId(editor))[0]!;
    editor.commands.text.insert({ blockId: id, offset: 0, value: "bold me" });
    const seen: MentionCreatedEvent[] = [];
    editor.events.on("MentionCreated", (events) => seen.push(...events));
    editor.commands.text.toggleMark({
      blockId: id,
      range: { start: 0, end: 4 },
      mark: "bold",
    });
    expect(seen).toHaveLength(0);
  });
});
