import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { wav } from "../server/test/private-wav-fixture.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";
if (
  process.env.TEST_DATABASE_URL &&
  !["localhost", "127.0.0.1"].includes(
    new URL(process.env.TEST_DATABASE_URL).hostname,
  )
)
  throw Error("Use a disposable loopback test database");
const dir = await mkdtemp(join(tmpdir(), "soundwave-upload-browser-")),
  f = await fixture(kind, {
    config: { privateMediaRoot: join(dir, "private"), uploadSeconds: 5 },
  }),
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
  async function api(path, method = "GET", body) {
    return page.evaluate(
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
  await page.goto(base + "/studio");
  await page.getByText(/A registered account is required/).waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const account = page.getByRole("region", { name: "Your account" });
  await account.getByLabel("Name", { exact: true }).fill("Audio author");
  await account
    .getByLabel("Email", { exact: true })
    .fill(`audio-${randomUUID()}@example.com`);
  await account
    .getByLabel("Password", { exact: true })
    .fill("browser upload password!");
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal(
    (await api("/creator", "POST", { displayName: "Audio author", bio: "" }))
      .status,
    200,
  );
  await page
    .getByRole("button", { name: "Retry stories", exact: true })
    .click();
  await page.getByText("No draft stories yet.", { exact: true }).waitFor();
  await page
    .getByLabel("Story title", { exact: true })
    .fill("Private audio story");
  await page.getByLabel("Genre", { exact: true }).fill("Test");
  await page
    .getByRole("button", { name: "Create draft story", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Private audio story", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add chapter", exact: true }).click();
  await page.getByLabel("Chapter title", { exact: true }).fill("Private voice");
  await page
    .getByRole("button", { name: "Create chapter", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Private voice", exact: true })
    .waitFor();
  const id = new URL(page.url()).searchParams.get("story"),
    draft = (await api(`/creator/stories/${id}`)).body,
    chapter = draft.chapters[0],
    path = `/creator/stories/${id}/chapters/${chapter.id}/media`;
  await page
    .getByRole("button", {
      name: "Manage audio for Private voice",
      exact: true,
    })
    .click();
  const section = page.getByRole("region", {
    name: "Private audio for Private voice",
    exact: true,
  });
  await section.getByText("Current audio: none", { exact: true }).waitFor();
  await section
    .getByLabel("Audio file for Private voice", { exact: true })
    .setInputFiles({
      name: "bad.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("not audio"),
    });
  await section
    .getByRole("alert")
    .filter({ hasText: "Select a nonempty WAV" })
    .waitFor();
  assert.equal((await api(path)).body.usedBytes, 0);
  pass(
    "real Studio creates a private chapter and rejects unsupported file selections before reservation",
  );
  await section
    .getByLabel("Audio file for Private voice", { exact: true })
    .setInputFiles({
      name: "malformed.wav",
      mimeType: "audio/wav",
      buffer: Buffer.alloc(100),
    });
  await section
    .getByRole("button", { name: "Upload private WAV", exact: true })
    .click();
  await section
    .getByRole("alert")
    .filter({ hasText: "Use a complete PCM" })
    .waitFor();
  await section
    .getByRole("button", { name: "Refresh media status", exact: true })
    .click();
  await section.getByText(/Upload status: failed/).waitFor();
  assert.equal((await api(path)).body.usedBytes, 0);
  pass(
    "server rejects a false WAV, UI recovers from validation failure and cleanup releases reserved quota",
  );
  const select = () =>
    section
      .getByLabel("Audio file for Private voice", { exact: true })
      .setInputFiles({
        name: "voice.wav",
        mimeType: "audio/wav",
        buffer: wav(8000),
      });
  await select();
  await section
    .getByRole("button", { name: "Upload private WAV", exact: true })
    .click();
  await section
    .getByText("Private audio validated. Still unpublished.", { exact: true })
    .waitFor();
  await section
    .getByText("Current audio: validated", { exact: true })
    .waitFor();
  assert.equal(
    await section.getByRole("progressbar").getAttribute("value"),
    "100",
  );
  const preview = section.locator("audio");
  await preview.evaluate((a) => a.play());
  await page.waitForFunction(() => {
    const a = document.querySelector(
      'audio[aria-label="Private preview for Private voice"]',
    );
    return a && a.currentTime > 0.03 && !a.paused;
  });
  await preview.evaluate((a) => a.pause());
  const current = (await api(path)).body.current;
  assert.equal(current.detectedType, "audio/wav");
  assert.equal(current.durationSeconds, 1);
  pass(
    "actual streamed WAV upload reports transfer progress, validates PCM and decodes in authenticated private preview without publishing",
  );
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page
    .getByRole("button", {
      name: "Manage audio for Private voice",
      exact: true,
    })
    .click();
  await section
    .getByText("Current audio: validated", { exact: true })
    .waitFor();
  assert.equal((await api(path)).body.current.id, current.id);
  await section.locator("audio").evaluate((a) => a.play());
  await page.waitForFunction(() => {
    const a = document.querySelector(
      'audio[aria-label="Private preview for Private voice"]',
    );
    return a && a.currentTime > 0.03;
  });
  await section.locator("audio").evaluate((a) => a.pause());
  assert.equal((await api(`/stories/${id}`)).status, 404);
  assert.equal((await api(`/library/${id}`, "PUT")).status, 404);
  assert.equal(
    await page.evaluate(
      async (chapter) =>
        (await fetch(`/api/chapters/${chapter}/stream`, { method: "HEAD" }))
          .status,
      chapter.id,
    ),
    404,
  );
  pass(
    "refresh restores persisted media metadata while public stories, favorites and streaming remain inaccessible",
  );
  // Hold only the browser transport before forwarding; backend abort/timeout
  // handling is separately exercised using real partially written HTTP requests.
  let release, seenResolve;
  const seen = new Promise((r) => (seenResolve = r));
  await page.route("**/media/*/bytes", async (route) => {
    seenResolve();
    await new Promise((r) => (release = r));
    await route.abort().catch(() => {});
  });
  await select();
  await section
    .getByRole("button", { name: "Upload private WAV", exact: true })
    .click();
  await seen;
  await section
    .getByRole("button", { name: "Cancel upload", exact: true })
    .click();
  release();
  await section
    .getByRole("alert")
    .filter({ hasText: /Upload cancelled/ })
    .waitFor();
  await page.unroute("**/media/*/bytes");
  await section
    .getByRole("button", { name: "Refresh media status", exact: true })
    .click();
  await section.getByText("Upload status: reserved", { exact: true }).waitFor();
  await section
    .getByRole("button", { name: "Cancel reserved upload", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Confirm remove private audio", exact: true })
    .click();
  await section
    .getByText("Private audio removed. Cleanup may finish asynchronously.", {
      exact: true,
    })
    .waitFor();
  assert.equal((await api(path)).body.current.id, current.id);
  assert.equal((await api(path)).body.usedBytes, wav(8000).length);
  pass(
    "cancel aborts a pending browser transfer; confirmed reservation cleanup keeps the previous validated audio and avoids duplicate quota",
  );
  await section
    .getByRole("button", { name: "Delete private audio", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Keep private audio", exact: true })
    .click();
  assert.equal((await api(path)).body.current.id, current.id);
  await section
    .getByRole("button", { name: "Delete private audio", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Confirm remove private audio", exact: true })
    .click();
  await section.getByText("Current audio: none", { exact: true }).waitFor();
  assert.equal((await api(path)).body.usedBytes, 0);
  assert.equal((await api(`${path}/${current.id}/preview`)).status, 404);
  pass(
    "private deletion requires confirmation, removes preview access and releases quota without changing chapter metadata",
  );
  const cached = await page.evaluate(async () => {
    const found = [];
    for (const key of await caches.keys())
      for (const req of await (await caches.open(key)).keys())
        if (new URL(req.url).pathname.startsWith("/api/creator"))
          found.push(req.url);
    return found;
  });
  assert.deepEqual(cached, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("*")]
          .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
          .map((e) => ({
            tag: e.tagName,
            className: e.className,
            width: e.getBoundingClientRect().width,
            right: e.getBoundingClientRect().right,
          }))
          .slice(-12),
      ),
    ),
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText(/Sign in with an active creator account/).waitFor();
  assert.equal(
    await page.locator('audio[aria-label^="Private preview"]').count(),
    0,
  );
  assert.equal((await api(path)).status, 401);
  assert.deepEqual(errors, []);
  pass(
    "private upload/preview data never enters PWA caches; mobile layout fits and logout removes private controls without browser exceptions",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} upload browser checks passed (${kind}).`,
  );
} catch (e) {
  await captureBrowserFailure(page, "uploads");
  throw e;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
  await rm(dir, { recursive: true, force: true });
}
