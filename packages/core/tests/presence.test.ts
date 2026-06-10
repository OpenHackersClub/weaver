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

describe("@weaver/core / presence — wire round-trip (specs/presence.md)", () => {
  it("local updates from one hub apply into another via the wire bytes", () => {
    const a = createPresenceHub();
    const b = createPresenceHub();
    const unsubscribe = a.subscribeLocalUpdates((bytes) => b.applyRemote(bytes));

    const rec = agentRecord("user:ada#tab1", {
      principalId: "user:ada",
      label: "Ada Lovelace",
      kind: "user",
      avatarUrl: "https://example.com/ada.png",
    });
    a.set(rec);
    expect(b.all()).toEqual([rec]);

    // A remove propagates too — the clean-exit path.
    a.remove(rec.peerId);
    expect(b.all()).toEqual([]);

    unsubscribe();
    a.dispose();
    b.dispose();
  });

  it("applyRemote does not re-fire subscribeLocalUpdates (no relay loop)", () => {
    const a = createPresenceHub();
    const b = createPresenceHub();
    let bLocalFires = 0;
    const unsubA = a.subscribeLocalUpdates((bytes) => b.applyRemote(bytes));
    const unsubB = b.subscribeLocalUpdates(() => bLocalFires++);

    a.set(agentRecord("agent-1"));
    expect(b.all()).toHaveLength(1);
    expect(bLocalFires).toBe(0);

    unsubA();
    unsubB();
    a.dispose();
    b.dispose();
  });

  it("encodeAll() carries the full roster to a late joiner", () => {
    const a = createPresenceHub();
    a.set(agentRecord("agent-1"));
    a.set(agentRecord("agent-2"));

    const late = createPresenceHub();
    late.applyRemote(a.encodeAll());
    expect(late.all().map((r) => r.peerId).sort()).toEqual([
      "agent-1",
      "agent-2",
    ]);

    a.dispose();
    late.dispose();
  });

  it("a record outlives a short timeout only while refreshed (heartbeat)", async () => {
    const hub = createPresenceHub({ timeoutMs: 150 });
    hub.set(agentRecord("agent-1"));

    // Refresh (heartbeat) twice across the window — record survives.
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 90));
      hub.set(agentRecord("agent-1"));
    }
    expect(hub.all()).toHaveLength(1);

    // Stop heartbeating — record is evicted after the timeout.
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.all()).toHaveLength(0);

    hub.dispose();
  });
});
