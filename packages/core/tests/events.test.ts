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
