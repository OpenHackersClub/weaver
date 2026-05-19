import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachPresenceOverlay,
  type PresenceCursor,
  type PresenceOverlay,
} from "../src/presence-overlay.js";

/**
 * Presence-overlay tests. jsdom has no real layout, so these assert on
 * structure and attributes (marker count, peer ids, labels) — not pixel
 * positions. See `specs/ai-agent.md` §2.2 for the presence model.
 */

let container: HTMLElement;
let host: HTMLElement;
let overlay: PresenceOverlay;

const block = (id: string, text: string): HTMLElement => {
  const p = document.createElement("p");
  p.setAttribute("data-block-id", id);
  p.appendChild(document.createTextNode(text));
  return p;
};

const PEER_SELECTOR = "[data-presence-peer]";

beforeEach(() => {
  container = document.createElement("div");
  host = document.createElement("div");
  host.setAttribute("contenteditable", "true");
  host.appendChild(block("blk-a", "first block"));
  host.appendChild(block("blk-b", "second block"));
  container.appendChild(host);
  document.body.appendChild(container);
  overlay = attachPresenceOverlay(host);
});

afterEach(() => {
  overlay.dispose();
  container.remove();
});

describe("@weaver/dom / attachPresenceOverlay", () => {
  it("appends a non-editable, non-interactive layer to the host's parent", () => {
    const layer = container.querySelector(".weaver-presence-layer") as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(container);
    expect(layer.getAttribute("contenteditable")).toBe("false");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.style.pointerEvents).toBe("none");
  });

  it("renders one marker per cursor with the right peer id and label", () => {
    const cursors: PresenceCursor[] = [
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-a", offset: 2 },
      { peerId: "agent-2", label: "Agent 2", color: "#00f", blockId: "blk-b", offset: 3 },
    ];
    overlay.render(cursors);

    const markers = Array.from(
      container.querySelectorAll(PEER_SELECTOR),
    ) as HTMLElement[];
    expect(markers).toHaveLength(2);

    const byPeer = new Map(
      markers.map((m) => [m.getAttribute("data-presence-peer"), m]),
    );
    expect(byPeer.has("agent-1")).toBe(true);
    expect(byPeer.has("agent-2")).toBe(true);
    expect(
      byPeer.get("agent-1")!.querySelector(".weaver-presence-label")!.textContent,
    ).toBe("Agent 1");
    expect(
      byPeer.get("agent-2")!.querySelector(".weaver-presence-label")!.textContent,
    ).toBe("Agent 2");
    expect(byPeer.get("agent-1")!.classList.contains("weaver-presence-caret")).toBe(
      true,
    );
  });

  it("carries the cursor color via the --presence-color custom property", () => {
    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "rebeccapurple", blockId: "blk-a", offset: 0 },
    ]);
    const marker = container.querySelector(PEER_SELECTOR) as HTMLElement;
    expect(marker.style.getPropertyValue("--presence-color")).toBe("rebeccapurple");
  });

  it("reuses the marker element for a peer across render calls", () => {
    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-a", offset: 1 },
    ]);
    const first = container.querySelector(PEER_SELECTOR);
    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-b", offset: 2 },
    ]);
    const second = container.querySelector(PEER_SELECTOR);
    expect(second).toBe(first);
  });

  it("drops a stale marker when its peer is absent from the next render", () => {
    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-a", offset: 1 },
      { peerId: "agent-2", label: "Agent 2", color: "#00f", blockId: "blk-b", offset: 1 },
    ]);
    expect(container.querySelectorAll(PEER_SELECTOR)).toHaveLength(2);

    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-a", offset: 1 },
    ]);
    const remaining = Array.from(
      container.querySelectorAll(PEER_SELECTOR),
    ) as HTMLElement[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.getAttribute("data-presence-peer")).toBe("agent-1");
  });

  it("skips a cursor whose block can't be resolved without throwing", () => {
    expect(() =>
      overlay.render([
        { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "missing", offset: 0 },
        { peerId: "agent-2", label: "Agent 2", color: "#00f", blockId: "blk-a", offset: 1 },
      ]),
    ).not.toThrow();
    const markers = container.querySelectorAll(PEER_SELECTOR);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute("data-presence-peer")).toBe("agent-2");
  });

  it("dispose removes the overlay layer from the DOM", () => {
    overlay.render([
      { peerId: "agent-1", label: "Agent 1", color: "#f00", blockId: "blk-a", offset: 0 },
    ]);
    expect(container.querySelector(".weaver-presence-layer")).not.toBeNull();
    overlay.dispose();
    expect(container.querySelector(".weaver-presence-layer")).toBeNull();
  });
});
