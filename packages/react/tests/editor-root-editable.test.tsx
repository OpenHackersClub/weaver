import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createEditor } from "@weaver/core";
import { EditorRoot } from "../src/index.js";

/**
 * `<EditorRoot editable={...}>` — the declarative half of the read-only
 * toggle (specs/lexical-parity.md §5 `useEditable()` row: "option on
 * `<WeaverEditor editable={...}>` + `useEditable()` reader").
 */

describe("@weaver/react / EditorRoot editable prop", () => {
  it("editable={false} renders a read-only surface", () => {
    const editor = createEditor();
    const { container, unmount } = render(
      <EditorRoot editor={editor} editable={false} />,
    );
    const host = container.querySelector("[data-weaver-root]")!;
    expect(editor.isEditable()).toBe(false);
    expect(host.getAttribute("contenteditable")).toBe("false");
    unmount();
    editor.dispose();
  });

  it("toggling the prop flips the editor and the DOM attribute", () => {
    const editor = createEditor();
    const { container, rerender, unmount } = render(
      <EditorRoot editor={editor} editable={true} />,
    );
    const host = container.querySelector("[data-weaver-root]")!;
    expect(host.getAttribute("contenteditable")).toBe("true");
    act(() => {
      rerender(<EditorRoot editor={editor} editable={false} />);
    });
    expect(editor.isEditable()).toBe(false);
    expect(host.getAttribute("contenteditable")).toBe("false");
    unmount();
    editor.dispose();
  });

  it("omitting the prop leaves the editor's own flag alone", () => {
    const editor = createEditor();
    editor.setEditable(false);
    const { unmount } = render(<EditorRoot editor={editor} />);
    expect(editor.isEditable()).toBe(false);
    unmount();
    editor.dispose();
  });
});
