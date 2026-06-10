import { test, expect, type Page } from "@playwright/test";

/**
 * "Tag someone" showcase — tagging fires `MentionCreated`, but the showcase
 * consumer (`MentionIntents`) does NOT react per-event: the chip lands before
 * the sentence is finished, so it debounces on edit-quiescence of the tagged
 * block (1.5 s quiet) and only then captures the FULL question after the tag
 * — the intent an LLM would process. The sidebar `MentionsLog` receives the
 * raw events too, debounced into one batch per burst.
 */

const SHOWCASE_URL = "/?example=mentions";
const QUESTION = "what is our latest spending?";

const focusLastBlock = async (page: Page) => {
  const blocks = page.locator("[data-weaver-root] [data-block-id]");
  await blocks.last().waitFor({ state: "visible" });
  await blocks.last().click();
  await page.keyboard.press("End");
};

interface IntentMirror {
  readonly principalId: string;
  readonly label: string;
  readonly origin: string;
  readonly question: string;
  readonly blockText: string;
}

const intents = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __weaver_mention_intents?: IntentMirror[] })
        .__weaver_mention_intents ?? [],
  );

const mentionBatches = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __weaver_mention_batches?: Array<
            Array<{ principalId: string; label: string; origin: string }>
          >;
        }
      ).__weaver_mention_batches ?? [],
  );

test.describe("Tag someone showcase", () => {
  test("the example seeds the showcase doc", async ({ page }) => {
    await page.goto(SHOWCASE_URL);
    await expect(
      page.locator("[data-weaver-root] [data-block-id]").first(),
    ).toHaveText("Tag someone — events demo");
    await expect(
      page.locator('.example-list button[data-active="true"]'),
    ).toHaveText("Tag someone");
  });

  test("tagging an agent captures the full question only after typing goes quiet", async ({
    page,
  }) => {
    await page.goto(SHOWCASE_URL);
    await focusLastBlock(page);

    await page.keyboard.type("@richard");
    await expect(page.locator("[data-mention-menu]")).toBeVisible();
    await page.keyboard.press("Enter");

    const chip = page.locator(".weaver-mention");
    await expect(chip).toHaveAttribute("data-mention-user-id", "agent-richard");

    // Keep typing the question — the consumer must NOT have reacted to the
    // chip alone: no toast, no captured intent while the block is still hot.
    await page.keyboard.type(QUESTION);
    await expect(page.locator("[data-mention-notification]")).toHaveCount(0);
    expect(await intents(page)).toHaveLength(0);

    // …then pause. After INTENT_QUIET_MS of silence the FULL question is
    // captured — not the truncated text from chip-insertion time.
    await expect
      .poll(async () => (await intents(page)).length, { timeout: 5000 })
      .toBe(1);
    const [intent] = await intents(page);
    expect(intent!.principalId).toBe("agent-richard");
    expect(intent!.question).toBe(QUESTION);
    expect(intent!.blockText).toBe(`Try it here: @Agent Richard ${QUESTION}`);

    const toast = page.locator("[data-mention-notification]");
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("@Agent Richard was asked");
    await expect(toast).toContainText(QUESTION);
    await expect(toast).toHaveAttribute("data-principal-id", "agent-richard");

    // The sidebar log got the raw event (debounced) — chip-time delivery.
    const logEntry = page.locator("[data-mentions-log] [data-mention-event]");
    await expect(logEntry).toHaveCount(1);
    await expect(logEntry).toHaveAttribute("data-principal-id", "agent-richard");
  });

  test("continuing to type keeps re-arming the quiet window", async ({
    page,
  }) => {
    await page.goto(SHOWCASE_URL);
    await focusLastBlock(page);

    await page.keyboard.type("@ada");
    await page.keyboard.press("Enter");
    await expect(page.locator(".weaver-mention")).toHaveCount(1);

    // Type slowly with gaps well under the quiet window — each keystroke
    // re-arms the timer, so nothing is captured mid-sentence.
    await page.keyboard.type("please review", { delay: 120 });
    expect(await intents(page)).toHaveLength(0);

    await expect
      .poll(async () => (await intents(page)).length, { timeout: 5000 })
      .toBe(1);
    const [intent] = await intents(page);
    expect(intent!.question).toBe("please review");
  });

  test("a burst of tags is one debounced log batch and one intent per principal", async ({
    page,
  }) => {
    await page.goto(SHOWCASE_URL);
    await page.locator("[data-weaver-root]").waitFor({ state: "visible" });

    await page.evaluate(() => {
      const dbg = (
        window as unknown as {
          __weaver_debug: { tree: () => Array<{ id: string }> };
        }
      ).__weaver_debug;
      const blockId = dbg.tree()[0]!.id;
      const w = window as unknown as {
        __weaver_mention_insert?: (
          blockId: string,
          at: number,
          id: string,
          label: string,
        ) => void;
      };
      if (!w.__weaver_mention_insert) {
        throw new Error("debug insert hook missing");
      }
      w.__weaver_mention_insert(blockId, 0, "user:ada", "Ada Lovelace");
      w.__weaver_mention_insert(blockId, 0, "agent-jared", "Agent Jared");
    });

    // Raw events: the burst lands in the sidebar log as ONE batch.
    await expect
      .poll(async () => (await mentionBatches(page)).length, { timeout: 3000 })
      .toBe(1);
    const batches = await mentionBatches(page);
    expect(batches[0]!.map((e) => e.principalId)).toEqual([
      "user:ada",
      "agent-jared",
    ]);

    // Intent capture: after the quiet window, one capture per principal.
    await expect
      .poll(async () => (await intents(page)).length, { timeout: 5000 })
      .toBe(2);
    expect((await intents(page)).map((i) => i.principalId)).toEqual([
      "user:ada",
      "agent-jared",
    ]);
    await expect(page.locator("[data-mention-notification]")).toHaveCount(2);
  });
});
