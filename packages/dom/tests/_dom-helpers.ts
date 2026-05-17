import { createEditor, type Editor } from "@weaver/core";
import { attachEditor, type AttachedBridge } from "../src/index.js";

export interface DomFixture {
  readonly editor: Editor;
  readonly host: HTMLElement;
  readonly bridge: AttachedBridge;
  type(s: string): void;
  press(inputType: string, data?: string): void;
  key(code: string, opts?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): void;
  blockEls(): HTMLElement[];
  blockKinds(): string[];
  blockTexts(): string[];
  destroy(): void;
}

const dispatchInput = (
  host: HTMLElement,
  inputType: string,
  data?: string,
): void => {
  host.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType,
      data: data ?? null,
      bubbles: true,
      cancelable: true,
    }),
  );
};

const placeCaretAtEnd = (host: HTMLElement): void => {
  const blocks = host.querySelectorAll("[data-block-id]");
  const last = blocks[blocks.length - 1] as HTMLElement | undefined;
  if (!last) return;
  const sel = host.ownerDocument.getSelection();
  if (!sel) return;
  const r = host.ownerDocument.createRange();
  // Walk text nodes to the end.
  const walker = host.ownerDocument.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let lastText: Text | null = null;
  while (walker.nextNode()) lastText = walker.currentNode as Text;
  if (lastText) {
    r.setStart(lastText, lastText.length);
    r.setEnd(lastText, lastText.length);
  } else {
    r.setStart(last, 0);
    r.setEnd(last, 0);
  }
  sel.removeAllRanges();
  sel.addRange(r);
};

export const setupDom = (): DomFixture => {
  const editor = createEditor({ origin: "user" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const bridge = attachEditor(editor, host);
  host.focus();
  placeCaretAtEnd(host);

  const fixture: DomFixture = {
    editor,
    host,
    bridge,
    type(s: string) {
      for (const ch of s) dispatchInput(host, "insertText", ch);
      placeCaretAtEnd(host);
    },
    press(inputType: string, data?: string) {
      dispatchInput(host, inputType, data);
    },
    key(code: string, opts = {}) {
      host.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: code,
          ctrlKey: opts.ctrlKey ?? false,
          metaKey: opts.metaKey ?? false,
          shiftKey: opts.shiftKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    blockEls() {
      return Array.from(host.querySelectorAll("[data-block-id]")) as HTMLElement[];
    },
    blockKinds() {
      return this.blockEls().map((el) => el.getAttribute("data-kind") ?? "");
    },
    blockTexts() {
      // Read from the LoroDoc (the single source of truth) keyed by the DOM
      // block ids — the rendered DOM pads empty blocks with a placeholder
      // space, which would otherwise be indistinguishable from real content.
      return this.blockEls().map((el) => {
        const id = el.getAttribute("data-block-id");
        return id ? editor.commands.text.read(id) : "";
      });
    },
    destroy() {
      bridge.detach();
      host.remove();
      editor.dispose();
    },
  };
  return fixture;
};
