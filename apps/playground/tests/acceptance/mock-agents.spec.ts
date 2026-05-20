import { test, expect, type Page } from "@playwright/test";

/**
 * Mock AI agents — acceptance tests (TDD red).
 *
 * The "Mock AI agents" feature (`specs/playground.md` § Mock AI agents and its
 * "### Mock AI agents" outcome-rubric subsection, plus `specs/ai-agent.md` §5)
 * is NOT built yet. Every test here is EXPECTED TO FAIL until the feature
 * lands — they encode the spec's rubric so the implementation can be graded
 * against them.
 *
 * Each `test` below maps to one rubric line. Tests use ONLY the deployed shape
 * of the app (DOM selectors + URL params + the `window.__weaver_debug` global
 * already used by `editor.spec.ts`) — never app internals.
 *
 * Mock agents are scripted/deterministic: agent-N's canned script inserts a
 * sentence containing the literal substring `agent-N`. There is no LLM and no
 * `/api/ai/*` traffic; the scripted runtime never makes a network call.
 */

const AGENT_EXAMPLE = "agent"; // the agent-collab example has id `agent`

const focusEditor = async (page: Page) => {
  const editor = page.locator("[data-weaver-root]");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  return editor;
};

/** Read the LoroDoc JSON snapshot exposed for tests on `window.__weaver_debug`. */
const snapshotText = async (page: Page): Promise<string> => {
  const snapshot = await page.evaluate(() =>
    (
      window as unknown as { __weaver_debug?: { snapshot: () => unknown } }
    ).__weaver_debug?.snapshot(),
  );
  return JSON.stringify(snapshot ?? null);
};

/** Local caret anchor offset, read directly from the live Selection. */
const anchorOffset = (page: Page): Promise<number | undefined> =>
  page.evaluate(() => window.getSelection()?.anchorOffset);

test.describe("Mock AI agents", () => {
  // Rubric: "?agents=0 (or absent) means no agents running."
  test("?agents=0 and absent — no presence carets and no running agent rows", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=0`);
    await focusEditor(page);
    await expect(page.locator("[data-presence-peer]")).toHaveCount(0);
    await expect(page.locator('[data-agent-row][data-running="true"]')).toHaveCount(
      0,
    );

    // The param being absent must behave identically to ?agents=0.
    await page.goto(`/?example=${AGENT_EXAMPLE}`);
    await focusEditor(page);
    await expect(page.locator("[data-presence-peer]")).toHaveCount(0);
    await expect(page.locator('[data-agent-row][data-running="true"]')).toHaveCount(
      0,
    );
  });

  // Rubric: "The Mock AI agents toggle is reachable from the UI."
  test("agents panel is reachable from the UI and the count buttons add agent rows", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}`);
    const panel = page.locator("[data-weaver-agents-panel]");
    await expect(panel).toBeVisible();

    await page.locator('[data-agents-set="2"]').click();
    await expect(page.locator("[data-agent-row]")).toHaveCount(2);
    await expect(page.locator('[data-agent-row="agent-1"]')).toBeVisible();
    await expect(page.locator('[data-agent-row="agent-2"]')).toBeVisible();
  });

  // Rubric: "reachable ... via the ?agents=<n> permalink param" +
  // "Turning on 2 mock agents yields ... two distinct presence cursors visible."
  test("?agents=2 permalink boots two agents with two distinct presence carets", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=2`);
    await focusEditor(page);

    // Auto-retrying assertion: carets appear once the agent peers join.
    await expect(page.locator("[data-presence-peer]")).toHaveCount(2);
    await expect(page.locator('[data-presence-peer="agent-1"]')).toBeVisible();
    await expect(page.locator('[data-presence-peer="agent-2"]')).toBeVisible();
  });

  // Rubric: "each agent's ops appearing in the op-log overlay tagged
  // `origin: agent-N` — one distinct origin per agent."
  test("each agent's ops appear in the op-log tagged origin=agent-N", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=2&debug=ops`);
    await focusEditor(page);

    const opLog = page.locator('[data-weaver-debug-panel="ops"]');
    await expect(opLog).toBeVisible();

    // Agents stream asynchronously — wait for each origin to show up.
    await expect(opLog).toContainText("origin=agent-1");
    await expect(opLog).toContainText("origin=agent-2");
  });

  // Rubric: "At least one streaming insertion from a running mock agent
  // carries the `agent-pending` mark, rendered with the distinct visual."
  test("a running agent's streamed text carries the agent-pending mark", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=1`);
    await focusEditor(page);

    // The agent-pending mark renders as span.weaver-agent-pending[data-agent].
    const pending = page.locator("span.weaver-agent-pending");
    await expect(pending.first()).toBeVisible();
    await expect(
      page.locator('span.weaver-agent-pending[data-agent="agent-1"]').first(),
    ).toBeVisible();
  });

  // Rubric: "The visitor can type concurrently while a mock agent streams: the
  // visitor's caret offset, read before and after a concurrent agent insert
  // made outside the visitor's block, is unchanged."
  test("visitor caret offset is unchanged across a concurrent agent insert", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=1`);
    await focusEditor(page);

    // Visitor types into an existing block that is NOT the agent's target block.
    const blocks = page.locator("[data-weaver-root] [data-block-id]");
    await blocks.first().click();
    await page.keyboard.type("visitor text");

    // Wait until the agent is actively streaming into its own block.
    await expect(page.locator("span.weaver-agent-pending").first()).toBeVisible();

    const before = await anchorOffset(page);
    expect(before).toBeGreaterThan(0);

    // Let a concurrent agent insert land while the caret sits in another block.
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-1")))
      .toBe(true);

    const after = await anchorOffset(page);
    // Loro merges the concurrent human↔agent edits without disturbing the
    // local caret — the offset must be identical before and after.
    expect(after).toBe(before);
  });

  // Rubric: "Rejecting one agent (that agent peer's own UndoManager.undo())
  // removes that mock agent's contribution without touching the other agent's
  // edits or the visitor's edits — Loro's undo is scoped to each peer."
  test("rejecting agent-1 removes only its contribution, leaving agent-2 and visitor text", async ({
    page,
  }) => {
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=2`);
    await focusEditor(page);

    // Visitor contributes their own identifiable text.
    await page.locator("[data-weaver-root] [data-block-id]").first().click();
    await page.keyboard.type("visitor-keepme");

    // Wait for both scripted agents to have streamed their sentences.
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-1")))
      .toBe(true);
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-2")))
      .toBe(true);

    await page.locator('[data-agent-reject="agent-1"]').click();

    // agent-1's contribution is undone via that peer's own UndoManager;
    // agent-2's edits and the visitor's text are untouched.
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-1")))
      .toBe(false);
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-2")))
      .toBe(true);
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("visitor-keepme")))
      .toBe(true);
  });

  // Rubric: "While mock agents run, no request is made to /api/ai/* and no
  // request carries agent edit payloads — the agents are scripted, not
  // LLM-backed (verified via Page.on('request') filtering for AI traffic)."
  test("running mock agents make no /api/ai/ network request", async ({ page }) => {
    const aiRequests: string[] = [];
    // Scripted agents replay canned edits in-tab; they never call an LLM.
    page.on("request", (req) => {
      if (/\/api\/ai\//.test(req.url())) aiRequests.push(req.url());
    });

    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=3`);
    await focusEditor(page);

    // Let all three agents stream.
    await expect(page.locator("span.weaver-agent-pending").first()).toBeVisible();
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-1")))
      .toBe(true);
    await expect
      .poll(() => snapshotText(page).then((s) => s.includes("agent-3")))
      .toBe(true);

    expect(aiRequests, aiRequests.join("\n")).toEqual([]);
  });

  // Rubric: "The 'ask' panel triggers a running mock agent to replay a
  // selected canned script; no LLM call results."
  test("the ask panel triggers a running agent to stream, with no /api/ai/ request", async ({
    page,
  }) => {
    const aiRequests: string[] = [];
    page.on("request", (req) => {
      if (/\/api\/ai\//.test(req.url())) aiRequests.push(req.url());
    });

    // Start with no auto-streaming agents so the stream is attributable to the
    // ask submission.
    await page.goto(`/?example=${AGENT_EXAMPLE}&agents=1`);
    await focusEditor(page);

    const askInput = page.locator("[data-agent-ask-input]");
    const askSubmit = page.locator("[data-agent-ask-submit]");
    await expect(askInput).toBeVisible();
    await expect(askSubmit).toBeVisible();

    await askInput.fill("rewrite the intro");
    await askSubmit.click();

    // Submitting the ask selects a canned script — a running agent streams,
    // producing agent-pending content.
    await expect(page.locator("span.weaver-agent-pending").first()).toBeVisible();

    // Still scripted: no LLM call resulted from the ask.
    expect(aiRequests, aiRequests.join("\n")).toEqual([]);
  });
});
