import { describe, expect, it } from "vitest";
import { createPresenceHub, type PresenceRecord } from "../src/index.js";

/**
 * `createPresenceHub` tests — the shared in-tab presence hub behind the
 * Playground peer panel (specs/playground.md § Mock AI agents,
 * specs/ai-agent.md §2.2).
 */

const agentRecord = (
  peerId: string,
  overrides: Partial<PresenceRecord> = {},
): PresenceRecord => ({
  peerId,
  label: `Agent ${peerId.replace("agent-", "")}`,
  color: "#e11d48",
  mode: "idle",
  cursor: null,
  ...overrides,
});

describe("@weaver/core / presence — set / all", () => {
  it("set publishes a record retrievable via all()", () => {
    const hub = createPresenceHub();
    expect(hub.all()).toEqual([]);

    const rec = agentRecord("agent-1");
    hub.set(rec);

    expect(hub.all()).toEqual([rec]);
    hub.dispose();
  });

  it("set on the same peerId overwrites the prior record", () => {
    const hub = createPresenceHub();
    hub.set(agentRecord("agent-1", { mode: "idle" }));
    hub.set(
      agentRecord("agent-1", {
        mode: "generating",
        cursor: { blockId: "block-7", offset: 3 },
      }),
    );

    const all = hub.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.mode).toBe("generating");
    expect(all[0]?.cursor).toEqual({ blockId: "block-7", offset: 3 });
    hub.dispose();
  });

  it("all() reflects multiple distinct peers", () => {
    const hub = createPresenceHub();
    hub.set(agentRecord("agent-1"));
    hub.set(agentRecord("agent-2"));
    hub.set(agentRecord("agent-3"));

    const ids = hub.all()
      .map((r) => r.peerId)
      .sort();
    expect(ids).toEqual(["agent-1", "agent-2", "agent-3"]);
    hub.dispose();
  });
});

describe("@weaver/core / presence — remove", () => {
  it("remove drops a peer's record", () => {
    const hub = createPresenceHub();
    hub.set(agentRecord("agent-1"));
    hub.set(agentRecord("agent-2"));

    hub.remove("agent-1");

    expect(hub.all().map((r) => r.peerId)).toEqual(["agent-2"]);
    hub.dispose();
  });

  it("removing an unknown peer is a no-op", () => {
    const hub = createPresenceHub();
    hub.set(agentRecord("agent-1"));
    expect(() => hub.remove("agent-99")).not.toThrow();
    expect(hub.all()).toHaveLength(1);
    hub.dispose();
  });
});

describe("@weaver/core / presence — subscribe", () => {
  it("subscribe fires the listener on set", () => {
    const hub = createPresenceHub();
    let fired = 0;
    const unsubscribe = hub.subscribe(() => fired++);

    hub.set(agentRecord("agent-1"));
    expect(fired).toBeGreaterThanOrEqual(1);

    unsubscribe();
    hub.dispose();
  });

  it("subscribe fires on remove", () => {
    const hub = createPresenceHub();
    hub.set(agentRecord("agent-1"));

    let fired = 0;
    const unsubscribe = hub.subscribe(() => fired++);
    hub.remove("agent-1");
    expect(fired).toBeGreaterThanOrEqual(1);

    unsubscribe();
    hub.dispose();
  });

  it("an unsubscribed listener stops firing", () => {
    const hub = createPresenceHub();
    let fired = 0;
    const unsubscribe = hub.subscribe(() => fired++);

    hub.set(agentRecord("agent-1"));
    const afterFirst = fired;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    unsubscribe();
    hub.set(agentRecord("agent-2"));
    expect(fired).toBe(afterFirst);

    hub.dispose();
  });
});
