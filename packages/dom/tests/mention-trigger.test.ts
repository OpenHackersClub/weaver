/**
 * @-mention trigger detection — the input half of the Notion-style mention
 * UX. Unit-tests `detectMentionTrigger`'s scan rules, then exercises the
 * bridge wiring: `BridgeOptions.onMentionTrigger` must follow the trigger
 * lifecycle (open on `@`, narrow per keystroke, dismiss on whitespace /
 * deletion) as the user types.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, getChildren, rootId, type Editor } from "@weaver/core";
import { detectMentionTrigger, type MentionTrigger } from "../src/index.js";
import { setupDom, type DomFixture } from "./_dom-helpers.js";

const editorWith = (value: string): { editor: Editor; id: string } => {
  const editor = createEditor();
  const id = getChildren(editor, rootId(editor))[0]!;
  editor.commands.text.insert({ blockId: id, offset: 0, value });
  return { editor, id };
};

describe("@weaver/dom / detectMentionTrigger", () => {
  it("detects @ at the start of a block", () => {
    const { editor, id } = editorWith("@ad");
    expect(detectMentionTrigger(editor, { blockId: id, offset: 3 })).toEqual({
      blockId: id,
      start: 0,
      end: 3,
      query: "ad",
    });
  });

  it("detects @ after whitespace, with an empty query right after typing @", () => {
    const { editor, id } = editorWith("say hi to @");
    expect(detectMentionTrigger(editor, { blockId: id, offset: 11 })).toEqual({
      blockId: id,
      start: 10,
      end: 11,
      query: "",
    });
  });

  it("does NOT trigger on a mid-word @ (emails, handles)", () => {
    const { editor, id } = editorWith("mail me ada@example");
    expect(
      detectMentionTrigger(editor, { blockId: id, offset: 19 }),
    ).toBeNull();
  });

  it("dismisses once whitespace enters the query", () => {
    const { editor, id } = editorWith("@ada lovelace");
    expect(
      detectMentionTrigger(editor, { blockId: id, offset: 13 }),
    ).toBeNull();
  });

  it("only sees the query up to the caret", () => {
    const { editor, id } = editorWith("@adamant");
    expect(detectMentionTrigger(editor, { blockId: id, offset: 4 })).toEqual({
      blockId: id,
      start: 0,
      end: 4,
      query: "ada",
    });
  });

  it("gives up beyond the max query length", () => {
    const { editor, id } = editorWith(`@${"x".repeat(41)}`);
    expect(
      detectMentionTrigger(editor, { blockId: id, offset: 42 }),
    ).toBeNull();
  });
});

describe("@weaver/dom / bridge onMentionTrigger", () => {
  let fixture: DomFixture | null = null;
  afterEach(() => {
    fixture?.destroy();
    fixture = null;
  });

  const setupWithTriggers = (): {
    fx: DomFixture;
    triggers: Array<MentionTrigger | null>;
  } => {
    const triggers: Array<MentionTrigger | null> = [];
    const fx = setupDom({ onMentionTrigger: (t) => triggers.push(t) });
    fixture = fx;
    return { fx, triggers };
  };

  it("opens on @, narrows per keystroke, and dismisses on whitespace", () => {
    const { fx, triggers } = setupWithTriggers();
    fx.type("hi @");
    expect(triggers[triggers.length - 1]).toMatchObject({
      start: 3,
      end: 4,
      query: "",
    });

    fx.type("ad");
    expect(triggers[triggers.length - 1]).toMatchObject({
      start: 3,
      end: 6,
      query: "ad",
    });

    fx.type(" ");
    expect(triggers[triggers.length - 1]).toBeNull();
  });

  it("deleting the @ dismisses the trigger", () => {
    const { fx, triggers } = setupWithTriggers();
    fx.type("@a");
    expect(triggers[triggers.length - 1]).toMatchObject({ query: "a" });
    fx.press("deleteContentBackward");
    expect(triggers[triggers.length - 1]).toMatchObject({ query: "" });
    fx.press("deleteContentBackward");
    expect(triggers[triggers.length - 1]).toBeNull();
  });

  it("never fires while no @ is involved", () => {
    const { fx, triggers } = setupWithTriggers();
    fx.type("plain text only");
    expect(triggers.every((t) => t === null)).toBe(true);
  });

  it("insertMention through the editor clears the trigger on the next input", () => {
    const { fx, triggers } = setupWithTriggers();
    fx.type("ping @ag");
    const active = triggers[triggers.length - 1];
    expect(active).toMatchObject({ start: 5, end: 8, query: "ag" });

    fx.editor.commands.text.insertMention({
      blockId: active!.blockId,
      range: { start: active!.start, end: active!.end },
      principal: { id: "agent-1", label: "Agent 1", kind: "agent" },
    });
    expect(fx.blockTexts()).toEqual(["ping @Agent 1 "]);

    // The chip is rendered with its data attributes after the bridge's
    // microtask reconcile — force it synchronously via rerender().
    fx.bridge.rerender();
    const chip = fx.host.querySelector(".weaver-mention");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-mention-user-id")).toBe("agent-1");
    expect(chip!.getAttribute("data-mention-kind")).toBe("agent");
  });
});
