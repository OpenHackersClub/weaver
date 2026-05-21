import { Schema } from "effect";

export type BlockId = string;
export const ROOT_ID: BlockId = "__root__";

export const BlockKindSchema = Schema.Literal(
  "paragraph",
  "heading",
  "quote",
  "bullet-list-item",
  "numbered-list-item",
  "to-do",
  "code",
  "divider",
  "image",
  "embed",
  "toggle",
  "table",
  "table-row",
  "table-cell",
);
export type BlockKind = Schema.Schema.Type<typeof BlockKindSchema>;

export const ParagraphAttrs = Schema.Struct({});
export const HeadingAttrs = Schema.Struct({
  level: Schema.Literal(1, 2, 3, 4, 5, 6),
});
export const QuoteAttrs = Schema.Struct({});
export const BulletAttrs = Schema.Struct({});
export const NumberedAttrs = Schema.Struct({});
export const TodoAttrs = Schema.Struct({ checked: Schema.Boolean });
export const CodeAttrs = Schema.Struct({
  language: Schema.optional(Schema.String),
});
export const DividerAttrs = Schema.Struct({});
export const ImageAttrs = Schema.Struct({
  src: Schema.String,
  alt: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});
export const EmbedAttrs = Schema.Struct({
  provider: Schema.String,
  url: Schema.String,
  sandbox: Schema.optional(Schema.Boolean),
});
export const ToggleAttrs = Schema.Struct({
  open: Schema.Boolean,
});
export const TableAttrs = Schema.Struct({
  columns: Schema.optional(Schema.Number),
});
export const TableRowAttrs = Schema.Struct({});
export const TableCellAttrs = Schema.Struct({
  header: Schema.optional(Schema.Boolean),
});

export type AttrsFor<K extends BlockKind> = K extends "paragraph"
  ? Schema.Schema.Type<typeof ParagraphAttrs>
  : K extends "heading"
    ? Schema.Schema.Type<typeof HeadingAttrs>
    : K extends "quote"
      ? Schema.Schema.Type<typeof QuoteAttrs>
      : K extends "bullet-list-item"
        ? Schema.Schema.Type<typeof BulletAttrs>
        : K extends "numbered-list-item"
          ? Schema.Schema.Type<typeof NumberedAttrs>
          : K extends "to-do"
            ? Schema.Schema.Type<typeof TodoAttrs>
            : K extends "code"
              ? Schema.Schema.Type<typeof CodeAttrs>
              : K extends "divider"
                ? Schema.Schema.Type<typeof DividerAttrs>
                : K extends "image"
                  ? Schema.Schema.Type<typeof ImageAttrs>
                  : K extends "embed"
                    ? Schema.Schema.Type<typeof EmbedAttrs>
                    : K extends "toggle"
                      ? Schema.Schema.Type<typeof ToggleAttrs>
                      : K extends "table"
                        ? Schema.Schema.Type<typeof TableAttrs>
                        : K extends "table-row"
                          ? Schema.Schema.Type<typeof TableRowAttrs>
                          : K extends "table-cell"
                            ? Schema.Schema.Type<typeof TableCellAttrs>
                            : never;

export type Block<K extends BlockKind = BlockKind> = {
  readonly id: BlockId;
  readonly kind: K;
  readonly attrs: AttrsFor<K>;
  readonly hasInline: boolean;
  readonly childIds: ReadonlyArray<BlockId>;
};

export const blockKindHasInline = (kind: BlockKind): boolean => {
  switch (kind) {
    case "paragraph":
    case "heading":
    case "quote":
    case "bullet-list-item":
    case "numbered-list-item":
    case "to-do":
    case "code":
    case "toggle":
    case "table-cell":
      return true;
    case "divider":
    case "image":
    case "embed":
    case "table":
    case "table-row":
      return false;
  }
};

export const defaultAttrsFor = <K extends BlockKind>(kind: K): AttrsFor<K> => {
  switch (kind) {
    case "paragraph":
      return {} as AttrsFor<K>;
    case "heading":
      return { level: 1 } as AttrsFor<K>;
    case "quote":
      return {} as AttrsFor<K>;
    case "bullet-list-item":
      return {} as AttrsFor<K>;
    case "numbered-list-item":
      return {} as AttrsFor<K>;
    case "to-do":
      return { checked: false } as AttrsFor<K>;
    case "code":
      return {} as AttrsFor<K>;
    case "divider":
      return {} as AttrsFor<K>;
    case "image":
      return { src: "" } as AttrsFor<K>;
    case "embed":
      return { provider: "", url: "" } as AttrsFor<K>;
    case "toggle":
      return { open: true } as AttrsFor<K>;
    case "table":
      return {} as AttrsFor<K>;
    case "table-row":
      return {} as AttrsFor<K>;
    case "table-cell":
      return {} as AttrsFor<K>;
  }
  return {} as AttrsFor<K>;
};
