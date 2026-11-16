// Real private Studio UI against disposable SQLite/PostgreSQL fixtures.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { waitForProgressSave } from "./browser-sync.mjs";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";
if (
  process.env.TEST_DATABASE_URL &&
  !["localhost", "127.0.0.1"].includes(
    new URL(process.env.TEST_DATABASE_URL).hostname,
  )
)
  throw Error("Use a disposable loopback TEST_DATABASE_URL");
const f = await fixture(kind),
  server = f.app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`,
  results = { date: new Date().toISOString(), database: kind, checks: [] };
const pass = (s) => {
  results.checks.push(s);
  console.log(`PASS ${results.checks.length}: ${s}`);
};
let browser, page;
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext(),
    errors = [];
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      if (
        window.failDraftReads &&
        path === "/api/creator/stories" &&
        (!options.method || options.method === "GET")
      )
        return Response.json(
          { error: { message: "Temporary Studio read failure" } },
          { status: 503 },
        );
      const response = await original(input, options);
      if (
        window.loseChapterAck &&
        options.method === "POST" &&
        /^\/api\/creator\/stories\/\d+\/chapters$/.test(path) &&
        response.status === 201
      ) {
        window.loseChapterAck = false;
        throw new TypeError("Simulated lost chapter acknowledgement");
      }
      if (
        window.holdStoryAck &&
        options.method === "POST" &&
        path === "/api/creator/stories" &&
        response.status === 201
      ) {
        window.holdStoryAck = false;
        const body = await response.json();
        window.heldDraftId = body.story.id;
        return new Promise((resolve) => {
          window.releaseDraftResponse = () =>
            resolve({
              ok: true,
              status: 201,
              json: async () => {
                window.lateDraftBodyRead = true;
                return body;
              },
            });
        });
      }
      return response;
    };
  });
  await page.goto(base + "/studio");
  async function api(path, method = "GET", body, target = page) {
    return target.evaluate(
      async ({ path, method, body }) => {
        const s = await fetch("/api/auth/session").then((r) => r.json());
        const r = await fetch("/api" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": s.csrfToken,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: r.status, body: await r.json() };
      },
      { path, method, body },
    );
  }
  await page
    .getByText(/A registered account is required for creator access/)
    .waitFor();
  assert.equal(
    (
      await api("/creator/stories", "POST", {
        title: "Forged",
        description: "",
        genre: "Test",
        language: "en",
        requestId: randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Create draft story", exact: true })
      .count(),
    0,
  );
  pass(
    "guests cannot create drafts; server and UI enforce creator eligibility",
  );
  const email = `draft-${randomUUID()}@example.com`,
    password = "private draft browser password!";
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const account = page.getByRole("region", { name: "Your account" });
  await account.getByLabel("Name", { exact: true }).fill("Draft author");
  await account.getByLabel("Email", { exact: true }).fill(email);
  await account.getByLabel("Password", { exact: true }).fill(password);
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal(
    (await api("/creator", "POST", { displayName: "Draft author", bio: "" }))
      .status,
    200,
  );
  await page
    .getByRole("button", { name: "Retry stories", exact: true })
    .click();
  await page.getByText("No draft stories yet.", { exact: true }).waitFor();
  const create = page.getByRole("region", {
      name: "Create Story",
      exact: true,
    }),
    editor = page.getByRole("region", { name: "Draft editor", exact: true });
  await create.getByLabel("Story title", { exact: true }).fill("Private moon");
  await create.getByLabel("Genre", { exact: true }).fill("Mystery");
  await create
    .getByRole("button", { name: "Create draft story", exact: true })
    .click();
  await editor
    .getByRole("heading", { name: "Private moon", exact: true })
    .waitFor();
  const id = new URL(page.url()).searchParams.get("story"),
    path = `/creator/stories/${id}`;
  await editor
    .getByLabel("Story title", { exact: true })
    .fill("Private moon edited");
  await editor
    .getByLabel("Description", { exact: true })
    .fill("Plain <img src=x onerror=alert(1)> metadata");
  await editor.getByText("Unsaved changes", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Save story", exact: true }).click();
  await editor
    .getByRole("heading", { name: "Private moon edited", exact: true })
    .waitFor();
  assert.equal((await api(path)).body.story.revision, 2);
  assert.equal(await editor.locator("img").count(), 0);
  pass(
    "registered active creator creates and edits a private story with revisioned plain-text metadata",
  );
  async function add(title) {
    await editor
      .getByRole("button", { name: "Add chapter", exact: true })
      .click();
    const form = editor.getByRole("form", { name: "Add chapter", exact: true });
    await form.getByLabel("Chapter title", { exact: true }).fill(title);
    await form
      .getByLabel("Chapter summary", { exact: true })
      .fill("Summary " + title);
    await form
      .getByRole("button", { name: "Create chapter", exact: true })
      .click();
    await editor
      .getByRole("button", { name: "Edit " + title, exact: true })
      .waitFor();
  }
  await add("One");
  await add("Two");
  await add("Three");
  await editor.getByRole("button", { name: "Edit One", exact: true }).click();
  await editor.getByLabel("Chapter title", { exact: true }).fill("One edited");
  await editor
    .getByRole("button", { name: "Save chapter", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Edit One edited", exact: true })
    .waitFor();
  await editor
    .getByRole("button", { name: "Move Three up", exact: true })
    .click();
  await editor.getByText("Chapter order saved.", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Remove Two", exact: true }).click();
  await editor
    .getByRole("button", { name: "Cancel operation", exact: true })
    .click();
  assert.equal((await api(path)).body.chapters.length, 3);
  const removed = (await api(path)).body.chapters.find(
    (c) => c.title === "Two",
  );
  await editor.getByRole("button", { name: "Remove Two", exact: true }).click();
  await editor
    .getByRole("button", { name: "Confirm remove chapter", exact: true })
    .click();
  await editor
    .getByText("Chapter removed. Its ID will not be reused.", { exact: true })
    .waitFor();
  assert.deepEqual(
    (await api(path)).body.chapters.map((c) => [c.title, c.position]),
    [
      ["One edited", 1],
      ["Three", 2],
    ],
  );
  assert.equal(
    (await api(path + "/chapters/" + removed.id)).body.chapter.removed,
    true,
  );
  pass(
    "chapter add/edit/reorder/remove flow persists contiguous order; removal confirmation retains the old ID",
  );
  await page.reload();
  await editor
    .getByRole("button", { name: "Edit One edited", exact: true })
    .waitFor();
  assert.deepEqual(
    (await api(path)).body.chapters.map((c) => c.title),
    ["One edited", "Three"],
  );
  pass(
    "refresh restores owned metadata, stable IDs, revisions and chapter order from the database",
  );
  await page.goto(base + "/stories/1");
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 1 &&
      !document.querySelector("audio")?.paused,
  );
  const before = await page
    .locator("audio")
    .evaluate((a) => ({ time: a.currentTime, src: a.currentSrc }));
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Creator Studio", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Private moon edited", exact: true })
    .click();
  await editor
    .getByLabel("Story title", { exact: true })
    .fill("Local conflict");
  const latest = (await api(path)).body.story;
  assert.equal(
    (
      await api(path, "PUT", {
        title: "Remote edit",
        description: latest.description,
        genre: latest.genre,
        language: latest.language,
        expectedRevision: latest.revision,
      })
    ).status,
    200,
  );
  await editor.getByRole("button", { name: "Save story", exact: true }).click();
  await editor
    .getByRole("heading", { name: "Draft changed", exact: true })
    .waitFor();
  await editor.getByText(/Latest story: Remote edit/).waitFor();
  await editor
    .getByRole("button", { name: "Review My Changes on Latest", exact: true })
    .click();
  await editor.getByText(/Your edits are ready for review/).waitFor();
  assert.equal(
    await editor.getByLabel("Story title", { exact: true }).inputValue(),
    "Local conflict",
  );
  assert.equal((await api(path)).body.story.title, "Remote edit");
  await editor.getByLabel("Story title", { exact: true }).fill("Resolved moon");
  await editor.getByRole("button", { name: "Save story", exact: true }).click();
  await editor
    .getByRole("heading", { name: "Resolved moon", exact: true })
    .waitFor();
  await page.waitForFunction((t) => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > t;
  }, before.time);
  assert.equal(
    await page.locator("audio").evaluate((a) => a.currentSrc),
    before.src,
  );
  const saved = waitForProgressSave(
    page,
    (p) => p.chapter_id === 101 && p.position_seconds > 0,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await saved;
  pass(
    "stale edits show current server state and require explicit review/save; Studio navigation preserves real audio playback",
  );
  const bodies = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === `/api${path}/chapters`
    )
      bodies.push(r.postDataJSON());
  });
  await editor
    .getByRole("button", { name: "Add chapter", exact: true })
    .click();
  await editor.getByLabel("Chapter title", { exact: true }).fill("Lost ACK");
  await page.evaluate(() => {
    window.loseChapterAck = true;
  });
  await editor
    .getByRole("button", { name: "Create chapter", exact: true })
    .click();
  await editor.getByText(/Save outcome unknown/).waitFor();
  assert.equal(
    (await api(path)).body.chapters.filter((c) => c.title === "Lost ACK")
      .length,
    1,
  );
  await editor
    .getByRole("button", { name: "Reload Latest", exact: true })
    .click();
  await editor
    .getByText(/Latest state loaded; retry the same chapter creation/)
    .waitFor();
  await editor
    .getByRole("button", { name: "Retry same chapter creation", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Edit Lost ACK", exact: true })
    .waitFor();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(
    (await api(path)).body.chapters.filter((c) => c.title === "Lost ACK")
      .length,
    1,
  );
  pass(
    "a committed chapter with a lost response is resolved using the same persisted UUID and original precondition, without duplicates",
  );
  await editor.getByRole("button", { name: "My Stories", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Resolved moon", exact: true })
    .waitFor();
  for (let i = 0; i < 21; i++)
    assert.equal(
      (
        await api("/creator/stories", "POST", {
          title: `Page draft ${i}`,
          description: "",
          genre: "Test",
          language: "en",
          requestId: randomUUID(),
        })
      ).status,
      201,
    );
  await page
    .getByRole("button", { name: "Refresh My Stories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load more stories", exact: true })
    .waitFor();
  assert.equal(await page.locator(".studio-list > li").count(), 20);
  await page
    .getByRole("button", { name: "Load more stories", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Resolved moon", exact: true })
    .waitFor();
  assert.equal(await page.locator(".studio-list > li").count(), 22);
  pass(
    "My Stories loads bounded 20-item pages and Load More appends the next private cursor page",
  );
  await page
    .getByRole("button", { name: "Open Resolved moon", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Archive story", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Cancel operation", exact: true })
    .click();
  assert.equal((await api(path)).body.story.state, "draft");
  await editor
    .getByRole("button", { name: "Archive story", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Confirm archive story", exact: true })
    .click();
  await editor
    .getByText("Story archived. Its chapters and IDs remain retained.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await editor.getByLabel("Story title", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await editor
      .getByRole("button", { name: "Add chapter", exact: true })
      .count(),
    0,
  );
  assert.equal((await api(`/stories/${id}`)).status, 404);
  assert.equal((await api(`/library/${id}`, "PUT")).status, 404);
  const chapter = (await api(path)).body.chapters[0];
  assert.equal(
    await page.evaluate(
      async (id) =>
        (
          await fetch(`/api/chapters/${id}/stream`, {
            method: "HEAD",
            headers: { Range: "bytes=0-10" },
          })
        ).status,
      chapter.id,
    ),
    404,
  );
  pass(
    "archive confirmation makes retained drafts read-only; public catalog, favorites and media cannot expose them",
  );
  // Deliberately hold a real accepted response across an account switch.
  const otherContext = await browser.newContext(),
    other = await otherContext.newPage();
  await other.goto(base + "/studio");
  await other
    .getByText(/A registered account is required for creator access/)
    .waitFor();
  const otherEmail = `other-draft-${randomUUID()}@example.com`;
  assert.equal(
    (
      await api(
        "/auth/register",
        "POST",
        { email: otherEmail, password, displayName: "Other author" },
        other,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        "/creator",
        "POST",
        { displayName: "Other author", bio: "" },
        other,
      )
    ).status,
    200,
  );
  await editor.getByRole("button", { name: "My Stories", exact: true }).click();
  await create
    .getByLabel("Story title", { exact: true })
    .fill("Held private response");
  await create.getByLabel("Genre", { exact: true }).fill("Test");
  await page.evaluate(() => {
    window.holdStoryAck = true;
  });
  await create
    .getByRole("button", { name: "Create draft story", exact: true })
    .click();
  await page.waitForFunction(
    () => typeof window.releaseDraftResponse === "function",
  );
  const heldId = await page.evaluate(() => window.heldDraftId);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await account.getByLabel("Email", { exact: true }).fill(otherEmail);
  await account.getByLabel("Password", { exact: true }).fill(password);
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("No draft stories yet.", { exact: true }).waitFor();
  await page.evaluate(() => window.releaseDraftResponse());
  await page.waitForFunction(() => window.lateDraftBodyRead === true);
  assert.equal(new URL(page.url()).searchParams.get("story"), null);
  assert.equal(
    await page.getByText("Held private response", { exact: true }).count(),
    0,
  );
  assert.equal((await api(`/creator/stories/${heldId}`)).status, 404);
  assert.deepEqual((await api("/creator/stories")).body.stories, []);
  await otherContext.close();
  pass(
    "a real accepted creation delayed across logout/login cannot navigate or leak private state into another account",
  );
  await page.evaluate(() => {
    window.failDraftReads = true;
  });
  await page
    .getByRole("button", { name: "Refresh My Stories", exact: true })
    .click();
  await page
    .getByText("Temporary Studio read failure", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.failDraftReads = false;
  });
  await page
    .getByRole("button", { name: "Retry stories", exact: true })
    .click();
  await page.getByText("No draft stories yet.", { exact: true }).waitFor();
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const key of await caches.keys())
      for (const req of await (await caches.open(key)).keys())
        if (
          /\/api\/(creator|auth|history|profile)(\/|$)/.test(
            new URL(req.url).pathname,
          )
        )
          paths.push(req.url);
    return paths;
  });
  assert.deepEqual(cached, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  pass(
    "Studio recovers from read errors, keeps private data out of PWA caches, fits mobile width and emits no uncaught errors",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} draft browser checks passed (${kind}).`,
  );
} catch (error) {
  await captureBrowserFailure(page, "drafts");
  throw error;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
