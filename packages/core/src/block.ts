import { Match, Schema } from "effect";

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

export const blockKindHasInline = (kind: BlockKind): boolean =>
  Match.value(kind).pipe(
    Match.whenOr(
      "paragraph",
      "heading",
      "quote",
      "bullet-list-item",
      "numbered-list-item",
      "to-do",
      "code",
      "toggle",
      "table-cell",
      () => true,
    ),
    Match.whenOr(
      "divider",
      "image",
      "embed",
      "table",
      "table-row",
      () => false,
    ),
    Match.exhaustive,
  );

export const defaultAttrsFor = <K extends BlockKind>(kind: K): AttrsFor<K> =>
  Match.value(kind as BlockKind).pipe(
    Match.when("heading", () => ({ level: 1 }) as AttrsFor<K>),
    Match.when("to-do", () => ({ checked: false }) as AttrsFor<K>),
    Match.when("image", () => ({ src: "" }) as AttrsFor<K>),
    Match.when("embed", () => ({ provider: "", url: "" }) as AttrsFor<K>),
    Match.when("toggle", () => ({ open: true }) as AttrsFor<K>),
    Match.whenOr(
      "paragraph",
      "quote",
      "bullet-list-item",
      "numbered-list-item",
      "code",
      "divider",
      "table",
      "table-row",
      "table-cell",
      () => ({}) as AttrsFor<K>,
    ),
    Match.exhaustive,
  );
