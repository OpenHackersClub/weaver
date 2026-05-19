import { useState } from "react";
import { useSubscriptionRef } from "@weaver/react";
import { MAX_AGENTS, type AgentsState, type MockAgentRuntime } from "./runtime.js";

const identity = (s: AgentsState): AgentsState => s;

/**
 * The Mock AI agents control surface (see `specs/playground.md` § Mock AI
 * agents → Controls): agent count, per-agent start/stop + reject, playback
 * speed, and the scripted "ask" panel.
 */
export const AgentsPanel = ({ runtime }: { runtime: MockAgentRuntime }) => {
  const state = useSubscriptionRef(runtime.state, identity);
  const [ask, setAsk] = useState("");

  const submitAsk = (): void => {
    const prompt = ask.trim();
    if (prompt.length === 0) return;
    runtime.ask(prompt);
    setAsk("");
  };

  return (
    <section data-weaver-agents-panel="">
      <h2>Mock AI agents</h2>
      <p className="agents-blurb">
        AI agents join this doc as CRDT peers — scripted, not LLM-backed.
      </p>

      <div className="agents-count" role="group" aria-label="Number of agents">
        {Array.from({ length: MAX_AGENTS + 1 }, (_, n) => (
          <button
            key={n}
            type="button"
            data-agents-set={n}
            data-active={state.count === n}
            onClick={() => runtime.setCount(n)}
          >
            {n}
          </button>
        ))}
      </div>

      <label className="agents-speed">
        Speed
        <input
          type="range"
          min={60}
          max={600}
          step={20}
          value={state.speedMs}
          data-agents-speed=""
          onChange={(e) => runtime.setSpeed(Number(e.target.value))}
        />
      </label>

      <ul className="agent-list">
        {state.agents.map((a) => (
          <li key={a.id} data-agent-row={a.id} data-running={a.running}>
            <span className="agent-dot" style={{ background: a.color }} />
            <span className="agent-name">{a.label}</span>
            <span className="agent-progress">
              {a.streamed}/{a.total}
            </span>
            <button
              type="button"
              data-agent-toggle={a.id}
              onClick={() => runtime.toggle(a.id)}
            >
              {a.running ? "Stop" : "Start"}
            </button>
            <button
              type="button"
              data-agent-reject={a.id}
              onClick={() => runtime.reject(a.id)}
            >
              Reject
            </button>
          </li>
        ))}
      </ul>

      <div className="agent-ask">
        <input
          type="text"
          data-agent-ask-input=""
          placeholder="Ask an agent…"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitAsk();
          }}
        />
        <button type="button" data-agent-ask-submit="" onClick={submitAsk}>
          Ask
        </button>
      </div>
    </section>
  );
};
