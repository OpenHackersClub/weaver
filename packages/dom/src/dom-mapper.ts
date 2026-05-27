import type { Block, BlockId, BlockKind, Editor } from "@weaver/core";
import { getBlock, getChildren, rootId } from "@weaver/core";
import { Match } from "effect";

const BLOCK_ATTR = "data-block-id";
const KIND_ATTR = "data-kind";
const LEVEL_ATTR = "data-level";

// `paragraph`, `image`, `embed`, `toggle`, and the `table` family fall
// through to `<p>` today — they still need dedicated DOM mapping (tracked
// against `specs/lexical-parity.md` §1). `Match.orElse` makes that pending
// work visible without losing the structural mapping for the kinds we do
// render: when each kind gets a real branch the `orElse` can switch to
// `Match.exhaustive` and the compiler will hold us to it.
export const tagFor = (kind: BlockKind, level?: number): string =>
  Match.value(kind).pipe(
    Match.when("heading", () => `h${Math.max(1, Math.min(6, level ?? 1))}`),
    Match.when("quote", () => "blockquote"),
    Match.whenOr(
      "bullet-list-item",
      "numbered-list-item",
      "to-do",
      () => "li",
    ),
    Match.when("code", () => "pre"),
    Match.when("divider", () => "hr"),
    Match.orElse(() => "p"),
  );

export const blockClassFor = (kind: BlockKind): string => `weaver-block weaver-${kind}`;

// Empty inline blocks need a node so the caret has somewhere to land. A
// zero-width space keeps the block focusable without contributing visible
// text — and acceptance tests strip U+200B when reading block text.
const EMPTY_PLACEHOLDER = "​";

const TODO_CONTENT_CLASS = "weaver-todo-content";

interface DeltaItem {
  readonly insert?: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * Wrap a plain-text run in inline mark elements, innermost-first. The
 * `agent-pending` mark (see `specs/ai-agent.md` §5 — the marker pattern) is
 * the outermost layer: in-progress agent generation renders as
 * `<span class="weaver-agent-pending" data-agent="<agentId>">`. Styling is
 * the playground app's job — this layer only carries the hook attributes.
 */
export const wrapWithMarks = (
  doc: Document,
  text: string,
  attrs: Record<string, unknown> | undefined,
): Node => {
  let node: Node = doc.createTextNode(text);
  if (!attrs) return node;
  if (attrs["code"]) {
    const c = doc.createElement("code");
    c.appendChild(node);
    node = c;
  }
  if (attrs["link"]) {
    const a = doc.createElement("a");
    if (typeof attrs["link"] === "string") a.setAttribute("href", attrs["link"]);
    a.appendChild(node);
    node = a;
  }
  if (attrs["underline"]) {
    const u = doc.createElement("u");
    u.appendChild(node);
    node = u;
  }
  if (attrs["strike"]) {
    const s = doc.createElement("s");
    s.appendChild(node);
    node = s;
  }
  if (attrs["italic"]) {
    const i = doc.createElement("em");
    i.appendChild(node);
    node = i;
  }
  if (attrs["bold"]) {
    const b = doc.createElement("strong");
    b.appendChild(node);
    node = b;
  }
  if (attrs["highlight"]) {
    const m = doc.createElement("mark");
    m.appendChild(node);
    node = m;
  }
  if (attrs["mention"]) {
    const span = doc.createElement("span");
    span.className = "weaver-mention";
    const val = attrs["mention"] as
      | { userId?: string; label?: string }
      | undefined;
    if (val?.userId) span.setAttribute("data-mention-user-id", val.userId);
    if (val?.label) span.setAttribute("data-mention-label", val.label);
    span.appendChild(node);
    node = span;
  }
  if (attrs["agent-pending"]) {
    const span = doc.createElement("span");
    span.className = "weaver-agent-pending";
    span.setAttribute("data-agent", String(attrs["agent-pending"]));
    span.appendChild(node);
    node = span;
  }
  return node;
};

const hasAnyMark = (attrs: Record<string, unknown> | undefined): boolean => {
  if (!attrs) return false;
  for (const k in attrs) {
    if (attrs[k]) return true;
  }
  return false;
};

const isSinglePlainTextDelta = (
  delta: ReadonlyArray<DeltaItem>,
): { text: string } | null => {
  if (delta.length !== 1) return null;
  const only = delta[0];
  if (!only || typeof only.insert !== "string") return null;
  if (hasAnyMark(only.attributes)) return null;
  return { text: only.insert };
};

const renderDeltaInto = (
  el: HTMLElement,
  delta: ReadonlyArray<DeltaItem>,
): void => {
  const doc = el.ownerDocument;
  // Fast path: a single plain-text run (the common keystroke case). Mutate
  // the existing text node's `data` instead of `replaceChildren()` so we
  // don't allocate per keystroke and we preserve the Text node identity
  // (so any external reference into it — including the live selection on
  // the off-chance we get here mid-restore — stays valid).
  const plain = isSinglePlainTextDelta(delta);
  if (plain !== null) {
    if (el.childNodes.length === 1 && el.firstChild instanceof Text) {
      if (el.firstChild.data !== plain.text) el.firstChild.data = plain.text;
      return;
    }
    el.replaceChildren(doc.createTextNode(plain.text));
    return;
  }
  el.replaceChildren();
  let totalLen = 0;
  for (const item of delta) {
    if (typeof item.insert !== "string" || item.insert.length === 0) continue;
    el.appendChild(wrapWithMarks(doc, item.insert, item.attributes));
    totalLen += item.insert.length;
  }
  if (totalLen === 0) {
    el.appendChild(doc.createTextNode(EMPTY_PLACEHOLDER));
  }
};

const syncTodoCheckbox = (check: HTMLElement, checked: boolean): void => {
  check.setAttribute("aria-checked", String(checked));
  check.classList.toggle("weaver-todo-checked", checked);
};

/**
 * Render inline content into a block element. A `to-do` block gets a
 * non-editable checkbox affordance plus a dedicated content span, so the
 * checkbox survives per-keystroke delta re-renders; every other inline kind
 * renders its delta straight into the block element.
 */
const renderInline = (
  el: HTMLElement,
  block: Block,
  delta: ReadonlyArray<DeltaItem>,
): void => {
  if (block.kind !== "to-do") {
    renderDeltaInto(el, delta);
    return;
  }
  const doc = el.ownerDocument;
  let check = el.querySelector("[data-todo-check]") as HTMLElement | null;
  let content = el.querySelector(`.${TODO_CONTENT_CLASS}`) as HTMLElement | null;
  if (!check || !content) {
    check = doc.createElement("span");
    check.setAttribute("data-todo-check", "");
    check.setAttribute("role", "checkbox");
    check.setAttribute("contenteditable", "false");
    content = doc.createElement("span");
    content.className = TODO_CONTENT_CLASS;
    el.replaceChildren(check, content);
  }
  syncTodoCheckbox(check, (block.attrs as { checked?: boolean }).checked === true);
  renderDeltaInto(content, delta);
};

export const renderBlockElement = (editor: Editor, blockId: BlockId): HTMLElement => {
  const block = getBlock(editor, blockId);
  if (!block) throw new Error(`renderBlockElement: missing ${blockId}`);
  const level = (block.attrs as { level?: number }).level;
  const tag = tagFor(block.kind, level);
  const el = document.createElement(tag);
  el.setAttribute(BLOCK_ATTR, blockId);
  el.setAttribute(KIND_ATTR, block.kind);
  if (block.kind === "heading" && typeof level === "number") {
    el.setAttribute(LEVEL_ATTR, String(level));
  }
  el.className = blockClassFor(block.kind);
  if (block.hasInline) {
    renderInline(
      el,
      block,
      editor.commands.text.toDelta(blockId) as ReadonlyArray<DeltaItem>,
    );
  }
  return el;
};

const updateBlockElement = (
  editor: Editor,
  el: HTMLElement,
  blockId: BlockId,
): HTMLElement => {
  const block = getBlock(editor, blockId);
  if (!block) return el;
  const level = (block.attrs as { level?: number }).level;
  const targetTag = tagFor(block.kind, level).toUpperCase();
  if (el.tagName !== targetTag) {
    const replacement = renderBlockElement(editor, blockId);
    el.replaceWith(replacement);
    return replacement;
  }
  if (el.getAttribute(KIND_ATTR) !== block.kind) {
    el.setAttribute(KIND_ATTR, block.kind);
    el.className = blockClassFor(block.kind);
  }
  if (block.kind === "heading" && typeof level === "number") {
    if (el.getAttribute(LEVEL_ATTR) !== String(level)) {
      el.setAttribute(LEVEL_ATTR, String(level));
    }
  } else if (el.hasAttribute(LEVEL_ATTR)) {
    el.removeAttribute(LEVEL_ATTR);
  }
  if (block.hasInline) {
    renderInline(
      el,
      block,
      editor.commands.text.toDelta(blockId) as ReadonlyArray<DeltaItem>,
    );
  } else if (el.childNodes.length > 0) {
    el.replaceChildren();
  }
  return el;
};

/**
 * Recursively render a block and its children into `host`, preserving
 * element identity on re-render (fast path for single-keystroke reconciles).
 * Nested child blocks are rendered as flat siblings under host so the DOM
 * always reflects document order — even for indented/nested blocks.
 */
const reconcileChildren = (
  editor: Editor,
  host: HTMLElement,
  parentId: BlockId,
): void => {
  const desired = getChildren(editor, parentId);
  const present = new Map<BlockId, HTMLElement>();
  for (const child of Array.from(host.children)) {
    const id = (child as HTMLElement).getAttribute(BLOCK_ATTR);
    if (id) present.set(id, child as HTMLElement);
  }
  let prevSibling: HTMLElement | null = null;
  for (const id of desired) {
    let el = present.get(id);
    if (!el) {
      el = renderBlockElement(editor, id);
      if (prevSibling === null) host.prepend(el);
      else prevSibling.after(el);
    } else {
      const expectedNext: ChildNode | null =
        prevSibling === null ? host.firstChild : prevSibling.nextSibling;
      if (expectedNext !== el) {
        if (prevSibling === null) host.prepend(el);
        else prevSibling.after(el);
      }
      el = updateBlockElement(editor, el, id);
      present.set(id, el);
    }
    prevSibling = el;
  }
  for (const [id, el] of present) {
    if (!desired.includes(id)) el.remove();
  }
};

export const reconcileTopLevel = (editor: Editor, host: HTMLElement): void => {
  reconcileChildren(editor, host, rootId(editor));
};

export const findBlockElement = (host: HTMLElement, blockId: BlockId): HTMLElement | null =>
  host.querySelector(`[${BLOCK_ATTR}="${CSS.escape(blockId)}"]`);

export const blockElementContaining = (
  host: HTMLElement,
  node: Node | null,
): HTMLElement | null => {
  let cur: Node | null = node;
  while (cur && cur !== host) {
    if (cur instanceof HTMLElement && cur.hasAttribute(BLOCK_ATTR)) return cur;
    cur = cur.parentNode;
  }
  return null;
};

export const blockIdOf = (el: HTMLElement): BlockId | null => el.getAttribute(BLOCK_ATTR);

export const TEXT_PLACEHOLDER = EMPTY_PLACEHOLDER;
