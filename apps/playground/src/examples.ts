import {
  type BlockKind,
  type Editor,
  getChildren,
  rootId,
} from "@weaver/core";

export type ExampleId = "empty" | "demo" | "multi";

export interface ExampleDef {
  readonly id: ExampleId;
  readonly label: string;
  readonly description: string;
}

export const EXAMPLES: ReadonlyArray<ExampleDef> = [
  {
    id: "empty",
    label: "Empty",
    description: "Start with a single blank paragraph.",
  },
  {
    id: "demo",
    label: "Demo",
    description: "A short tour covering paragraph, heading, list and code-style content.",
  },
  {
    id: "multi",
    label: "Multi-paragraph",
    description: "Several paragraphs for multi-block editing practice.",
  },
];

const seedBlock = (
  editor: Editor,
  index: number,
  kind: BlockKind,
  attrs: Record<string, unknown>,
  text: string,
): void => {
  const id = editor.commands.block.insert({
    parentId: rootId(editor),
    index,
    kind,
    attrs,
  });
  if (text.length > 0) {
    editor.commands.text.insert({ blockId: id, offset: 0, value: text });
  }
};

const clearAllBlocks = (editor: Editor): void => {
  const ids = getChildren(editor, rootId(editor));
  for (const id of ids) {
    editor.commands.block.delete({ blockId: id });
  }
  // ensure at least one paragraph remains so the editor never has zero blocks
  if (getChildren(editor, rootId(editor)).length === 0) {
    editor.commands.block.insert({
      parentId: rootId(editor),
      index: 0,
      kind: "paragraph",
      attrs: {},
    });
  }
};

const replaceFirstBlock = (
  editor: Editor,
  kind: BlockKind,
  attrs: Record<string, unknown>,
  text: string,
): void => {
  const ids = getChildren(editor, rootId(editor));
  const first = ids[0];
  if (!first) {
    seedBlock(editor, 0, kind, attrs, text);
    return;
  }
  editor.commands.block.transform({ blockId: first, newKind: kind, attrs });
  const existing = editor.commands.text.read(first);
  if (existing.length > 0) {
    editor.commands.text.delete({ blockId: first, offset: 0, length: existing.length });
  }
  if (text.length > 0) {
    editor.commands.text.insert({ blockId: first, offset: 0, value: text });
  }
};

export const seedExample = (editor: Editor, id: ExampleId): void => {
  clearAllBlocks(editor);
  switch (id) {
    case "empty":
      return;
    case "demo": {
      replaceFirstBlock(editor, "heading", { level: 1 }, "Welcome to weaver");
      seedBlock(
        editor,
        1,
        "paragraph",
        {},
        "This editor stores every keystroke in a LoroDoc — the single source of truth.",
      );
      seedBlock(editor, 2, "heading", { level: 2 }, "What works today");
      seedBlock(editor, 3, "paragraph", {}, "Try typing here. Press Enter to split a block.");
      seedBlock(
        editor,
        4,
        "paragraph",
        {},
        "Use Ctrl/Cmd + B to bold a selection. Use '# ' or '## ' at the start of a paragraph to convert it to a heading.",
      );
      seedBlock(editor, 5, "heading", { level: 2 }, "What is not yet implemented");
      seedBlock(
        editor,
        6,
        "paragraph",
        {},
        "Lists, code blocks, tables, embeds, suggestion mode, comments, AI agent peers, sync, and access control all live in specs/ and adr/ and are next on the roadmap.",
      );
      return;
    }
    case "multi": {
      replaceFirstBlock(editor, "paragraph", {}, "Paragraph one — try clicking here and typing.");
      for (let i = 2; i <= 6; i++) {
        seedBlock(editor, i - 1, "paragraph", {}, `Paragraph ${i}.`);
      }
      return;
    }
  }
};
