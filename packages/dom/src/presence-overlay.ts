/**
 * Remote agent caret overlay.
 *
 * Draws non-editable presence carets (a moving caret + a label flag) for
 * remote CRDT peers — humans or mock AI agents — over the editor's
 * contenteditable host. This is the DOM half of the peer-presence model in
 * `specs/ai-agent.md` §2.2: agents appear as presence records with a scoped
 * cursor and a color hint.
 *
 * Framework-agnostic by design — it operates purely on the host DOM and the
 * `PresenceCursor` data; it imports neither React nor `@weaver/core`. The
 * caller is responsible for translating `EphemeralStore` presence records
 * (or mock-agent scripts) into `PresenceCursor` values.
 */

export interface PresenceCursor {
  /** Stable peer identity, e.g. `"agent-1"`. */
  readonly peerId: string;
  /** Human-readable label rendered in the caret's flag, e.g. `"Agent 1"`. */
  readonly label: string;
  /** CSS color for the caret + flag. */
  readonly color: string;
  /** The block the caret sits in (`data-block-id`). */
  readonly blockId: string;
  /** Character offset within the block's text. */
  readonly offset: number;
}

export interface PresenceOverlay {
  /** Redraw the overlay to exactly the supplied set of cursors. */
  render(cursors: ReadonlyArray<PresenceCursor>): void;
  /** Remove the overlay layer from the DOM. */
  dispose(): void;
}

const LAYER_CLASS = "weaver-presence-layer";
const CARET_CLASS = "weaver-presence-caret";
const LABEL_CLASS = "weaver-presence-label";
const PEER_ATTR = "data-presence-peer";

/**
 * Walk `el`'s text nodes to `offset` and return a DOM Range collapsed at that
 * point. Falls back to the element start when the block has no text node.
 */
const collapsedRangeAt = (
  doc: Document,
  el: HTMLElement,
  offset: number,
): Range => {
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    last = t;
    if (remaining <= t.length) {
      const r = doc.createRange();
      r.setStart(t, remaining);
      r.collapse(true);
      return r;
    }
    remaining -= t.length;
  }
  if (last) {
    const r = doc.createRange();
    r.setStart(last, last.length);
    r.collapse(true);
    return r;
  }
  // No text node — anchor at the start of the element itself.
  const r = doc.createRange();
  r.setStart(el, 0);
  r.collapse(true);
  return r;
};

const ZERO_RECT = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
} as DOMRect;

const rectFor = (range: Range): DOMRect => {
  // jsdom implements neither getClientRects nor getBoundingClientRect on
  // Range — fall back to a zero rect so the marker still anchors structurally.
  if (typeof range.getClientRects === "function") {
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[0]!;
  }
  if (typeof range.getBoundingClientRect === "function") {
    return range.getBoundingClientRect();
  }
  return ZERO_RECT;
};

/**
 * Attach an absolutely-positioned, non-editable overlay layer for drawing
 * remote agent carets over `host` (the editor contenteditable element).
 */
export const attachPresenceOverlay = (host: HTMLElement): PresenceOverlay => {
  const doc = host.ownerDocument;
  const parent = host.parentElement ?? host;

  const layer = doc.createElement("div");
  layer.className = LAYER_CLASS;
  layer.setAttribute("contenteditable", "false");
  layer.setAttribute("aria-hidden", "true");
  // The layer must never capture input — it sits over the editable surface.
  layer.style.position = "absolute";
  layer.style.top = "0";
  layer.style.left = "0";
  layer.style.pointerEvents = "none";
  parent.appendChild(layer);

  // Markers reused across render() calls, keyed by peerId.
  const markers = new Map<string, HTMLElement>();

  const makeMarker = (peerId: string): HTMLElement => {
    const caret = doc.createElement("span");
    caret.className = CARET_CLASS;
    caret.setAttribute(PEER_ATTR, peerId);
    caret.style.position = "absolute";
    caret.style.pointerEvents = "none";
    const label = doc.createElement("span");
    label.className = LABEL_CLASS;
    caret.appendChild(label);
    return caret;
  };

  const render = (cursors: ReadonlyArray<PresenceCursor>): void => {
    const seen = new Set<string>();
    // The layer's offset parent is the coordinate frame for left/top.
    const frame = layer.getBoundingClientRect();

    for (const cursor of cursors) {
      const blockEl = host.querySelector(
        `[data-block-id="${CSS.escape(cursor.blockId)}"]`,
      ) as HTMLElement | null;
      if (!blockEl) continue;
      const range = collapsedRangeAt(doc, blockEl, cursor.offset);
      const rect = rectFor(range);

      let marker = markers.get(cursor.peerId);
      if (!marker) {
        marker = makeMarker(cursor.peerId);
        markers.set(cursor.peerId, marker);
        layer.appendChild(marker);
      }
      seen.add(cursor.peerId);

      marker.style.setProperty("--presence-color", cursor.color);
      marker.style.left = `${rect.left - frame.left}px`;
      marker.style.top = `${rect.top - frame.top}px`;
      const label = marker.querySelector(`.${LABEL_CLASS}`);
      if (label) label.textContent = cursor.label;
    }

    // Drop markers whose peer is absent from the new list.
    for (const [peerId, marker] of markers) {
      if (!seen.has(peerId)) {
        marker.remove();
        markers.delete(peerId);
      }
    }
  };

  const dispose = (): void => {
    markers.clear();
    layer.remove();
  };

  return { render, dispose };
};
