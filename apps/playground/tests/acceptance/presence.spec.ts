import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "@weaver/server-node";

/**
 * Live presence over the wire (`specs/presence.md` §Playground demo +
 * §Verification): two real browser contexts (two "users") connect to a live
 * `@weaver/server-node` relay on the same doc, and each tab's facepile shows
 * BOTH identities; doc edits sync between the tabs over the same socket;
 * closing a tab removes its avatar from the survivor (clean-exit delete).
 *
 * The relay is booted in-process on an ephemeral port — no fixtures touch the
 * network beyond 127.0.0.1.
 */

let server: RunningServer;

test.beforeAll(async () => {
  server = await startServer({ port: 0 });
});

test.afterAll(async () => {
  await server.close();
});

interface Tab {
  readonly context: BrowserContext;
  readonly page: Page;
}

const openTab = async (
  browser: Browser,
  docId: string,
  me: string,
): Promise<Tab> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const ws = encodeURIComponent(`ws://127.0.0.1:${server.port}`);
  await page.goto(`/?ws=${ws}&doc=${docId}&me=${encodeURIComponent(me)}`);
  await expect(page.locator('[data-collab-state="live"]')).toBeVisible();
  return { context, page };
};

const face = (page: Page, principalId: string) =>
  page.locator(`[data-presence-principal="${principalId}"]`);

test.describe("Presence over the wire", () => {
  test("two tabs see each other's avatar and identity in the facepile", async ({
    browser,
  }) => {
    const a = await openTab(browser, "presence-roster", "user:ada");
    const b = await openTab(browser, "presence-roster", "user:grace");

    // Each tab shows itself…
    await expect(face(a.page, "user:ada")).toBeVisible();
    await expect(face(b.page, "user:grace")).toBeVisible();
    // …and the other tab, with the right display identity.
    await expect(face(a.page, "user:grace")).toBeVisible();
    await expect(face(b.page, "user:ada")).toBeVisible();
    await expect(face(a.page, "user:grace")).toHaveAttribute(
      "title",
      "Grace Hopper",
    );
    await expect(face(b.page, "user:ada")).toHaveAttribute(
      "title",
      "Ada Lovelace",
    );

    await a.context.close();
    await b.context.close();
  });

  test("a late joiner gets the roster from catch-up, without anyone re-announcing", async ({
    browser,
  }) => {
    const a = await openTab(browser, "presence-late", "user:ada");
    await expect(face(a.page, "user:ada")).toBeVisible();

    const b = await openTab(browser, "presence-late", "user:linus");
    // The roster arrives in the connect-time catch-up frames — well inside
    // the default expect timeout, no heartbeat (15 s) required.
    await expect(face(b.page, "user:ada")).toBeVisible();

    await a.context.close();
    await b.context.close();
  });

  test("doc edits sync live between the two tabs", async ({ browser }) => {
    const a = await openTab(browser, "presence-edits", "user:ada");
    const b = await openTab(browser, "presence-edits", "user:grace");

    // A fresh room is seeded with the selected example shortly after connect;
    // typing before any block exists has no model target, so wait for it.
    const editorA = a.page.locator("[data-weaver-root]");
    await expect(editorA.locator("[data-block-id]").first()).toBeVisible();
    await editorA.click();
    await a.page.keyboard.type("hello from ada");

    await expect(b.page.locator("[data-weaver-root]")).toContainText(
      "hello from ada",
    );

    // And the reverse direction over the same sockets.
    const editorB = b.page.locator("[data-weaver-root]");
    await editorB.click();
    await b.page.keyboard.press("End");
    await b.page.keyboard.type(" — hi, grace here");
    await expect(a.page.locator("[data-weaver-root]")).toContainText(
      "hi, grace here",
    );

    await a.context.close();
    await b.context.close();
  });

  test("a tab's caret appears in the other tab's overlay — cursors and facepile share one identity set", async ({
    browser,
  }) => {
    const a = await openTab(browser, "presence-carets", "user:ada");
    const b = await openTab(browser, "presence-carets", "user:grace");

    // Ada places a selection by clicking into the first block.
    const editorA = a.page.locator("[data-weaver-root]");
    await expect(editorA.locator("[data-block-id]").first()).toBeVisible();
    await editorA.locator("[data-block-id]").first().click();

    // Grace's tab renders Ada's caret (session-scoped peer key, principal
    // prefix) — the same identity that her facepile entry carries.
    await expect(
      b.page.locator('[data-presence-peer^="user:ada"]'),
    ).toBeVisible();
    await expect(face(b.page, "user:ada")).toBeVisible();

    // And never her own: the local caret is the real DOM caret.
    await expect(
      b.page.locator('[data-presence-peer^="user:grace"]'),
    ).toHaveCount(0);

    await a.context.close();
    await b.context.close();
  });

  test("closing a tab removes its avatar from the survivor", async ({
    browser,
  }) => {
    const a = await openTab(browser, "presence-leave", "user:ada");
    const b = await openTab(browser, "presence-leave", "user:grace");
    await expect(face(a.page, "user:grace")).toBeVisible();

    // Navigating away fires the clean-exit delete (beforeunload + unmount);
    // the survivor sees the avatar drop without waiting out the 45 s timeout.
    await b.page.goto("about:blank");
    await expect(face(a.page, "user:grace")).toHaveCount(0);

    await a.context.close();
    await b.context.close();
  });
});
