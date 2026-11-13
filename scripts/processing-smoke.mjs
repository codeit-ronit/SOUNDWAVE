import { localPrivateStorage } from "../server/storage/local-private.js";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { wav } from "../server/test/private-wav-fixture.js";
import { processPrivateMedia } from "../server/media/private-processor.js";
import {
  privateProcessingQueue,
  startPrivateProcessingWorker,
} from "../server/media/private-queue.js";
import { runOnce } from "../server/jobs/worker.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";
if (
  !process.env.TEST_REDIS_URL ||
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.TEST_REDIS_URL).hostname,
  ) ||
  (process.env.TEST_DATABASE_URL &&
    !["127.0.0.1", "localhost"].includes(
      new URL(process.env.TEST_DATABASE_URL).hostname,
    ))
)
  throw Error(
    "Explicit disposable loopback PostgreSQL/Redis services required",
  );
const dir = await mkdtemp(join(tmpdir(), "processing-browser-")),
  f = await fixture(kind, {
    config: {
      privateMediaRoot: join(dir, "objects"),
      redisUrl: process.env.TEST_REDIS_URL,
      redisPrefix: "ci-processing-" + randomUUID(),
      processingSeconds: 5,
      derivativeMaxBytes: 262144,
    },
  }),
  server = f.app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`,
  results = { date: new Date().toISOString(), database: kind, checks: [] };
let browser, page, worker, queue, release;
const pass = (s) => {
  results.checks.push(s);
  console.log(`PASS ${results.checks.length}: ${s}`);
};
async function until(fn) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await fn()) return;
    await turn();
  }
  throw Error("Processing state deadline exceeded");
}
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  page = await browser.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
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
  await account.getByLabel("Name", { exact: true }).fill("MP3 creator");
  await account
    .getByLabel("Email", { exact: true })
    .fill(`${randomUUID()}@example.com`);
  await account
    .getByLabel("Password", { exact: true })
    .fill("processing browser password!");
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal(
    (await api("/creator", "POST", { displayName: "MP3 creator", bio: "" }))
      .status,
    200,
  );
  await page
    .getByRole("button", { name: "Retry stories", exact: true })
    .click();
  await page.getByText("No draft stories yet.", { exact: true }).waitFor();
  await page
    .getByLabel("Story title", { exact: true })
    .fill("Processed private story");
  await page.getByLabel("Genre", { exact: true }).fill("Test");
  await page
    .getByRole("button", { name: "Create draft story", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Processed private story", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add chapter", exact: true }).click();
  await page.getByLabel("Chapter title", { exact: true }).fill("MP3 voice");
  await page
    .getByRole("button", { name: "Create chapter", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage audio for MP3 voice", exact: true })
    .click();
  const section = page.getByRole("region", {
    name: "Private audio for MP3 voice",
    exact: true,
  });
  await section.getByText("Current audio: none", { exact: true }).waitFor();
  await section
    .getByLabel("Audio file for MP3 voice", { exact: true })
    .setInputFiles({
      name: "voice.wav",
      mimeType: "audio/wav",
      buffer: wav(8000),
    });
  await section
    .getByRole("button", { name: "Upload private WAV", exact: true })
    .click();
  await section
    .getByText("Current audio: validated", { exact: true })
    .waitFor();
  await section
    .getByText("Processing: pending · Stage: pending · Attempts: 0", {
      exact: true,
    })
    .waitFor();
  const id = new URL(page.url()).searchParams.get("story"),
    draft = (await api(`/creator/stories/${id}`)).body,
    ch = draft.chapters[0],
    path = `/creator/stories/${id}/chapters/${ch.id}/media`,
    source = (await api(path)).body.current,
    p = await f.db
      .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
      .get(source.id);
  assert.ok(p.outbox_id);
  pass(
    "upload persists a genuine pending processing intent and outbox; technical validation does not show MP3 ready",
  );
  queue = privateProcessingQueue(f.config);
  let entered;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  worker = startPrivateProcessingWorker(f.db, f.config, {
    processor: (db, c, intent, options) =>
      processPrivateMedia(db, c, intent, {
        ...options,
        hooks: {
          afterClaim: async () => {
            entered();
            await gate;
          },
        },
      }),
  });
  await runOnce(f.db, { privateQueue: queue });
  await started;
  await section
    .getByRole("button", { name: "Refresh media status", exact: true })
    .click();
  await section
    .getByText("Processing: processing · Stage: hashing · Attempts: 1", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await section
      .getByRole("region", { name: "Derivative processing" })
      .locator("progress")
      .count(),
    0,
  );
  pass(
    "Studio exposes the actual claimed processing stage without simulated percentages",
  );
  release();
  await until(
    async () =>
      (
        await f.db
          .prepare("SELECT status FROM private_processing_intents WHERE id=?")
          .get(p.id)
      ).status === "ready",
  );
  await section
    .getByRole("button", { name: "Refresh media status", exact: true })
    .click();
  await section
    .getByText("Processing: ready · Stage: ready · Attempts: 1", {
      exact: true,
    })
    .waitFor();
  const mp3 = section.getByLabel("Private MP3 preview for MP3 voice", {
    exact: true,
  });
  await mp3.evaluate((a) => a.play());
  await page.waitForFunction(
    () =>
      document.querySelector(
        'audio[aria-label="Private MP3 preview for MP3 voice"]',
      )?.currentTime > 0.03,
  );
  await mp3.evaluate((a) => a.pause());
  assert.equal(
    await section
      .getByLabel("Private preview for MP3 voice", { exact: true })
      .count(),
    1,
  );
  pass(
    "real BullMQ/FFmpeg output decodes in native MP3 preview while the original WAV stays available and unpublished",
  );
  const before = (await api(path)).body.derivative,
    output = await f.db
      .prepare("SELECT object_key FROM private_media_outputs WHERE id=?")
      .get(before.id);
  await localPrivateStorage(f.config.privateMediaRoot).remove(
    output.object_key,
  );
  assert.equal(
    await page.evaluate(
      async (url) => (await fetch(url, { method: "HEAD" })).status,
      `/api${path}/${source.id}/derivative`,
    ),
    503,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Manage audio for MP3 voice", exact: true })
    .click();
  await section.getByText(/Processing: ready/).waitFor();

  await mp3.evaluate((a) => {
    a.load();
    return a.play().catch(() => {});
  });
  await section
    .getByRole("button", { name: "Retry Processing", exact: true })
    .waitFor();
  await section
    .getByRole("button", { name: "Retry Processing", exact: true })
    .click();
  await section.getByText(/Processing: pending/).waitFor();
  await runOnce(f.db, { privateQueue: queue });
  await until(
    async () =>
      (
        await f.db
          .prepare("SELECT status FROM private_processing_intents WHERE id=?")
          .get(p.id)
      ).status === "ready",
  );
  await section
    .getByRole("button", { name: "Refresh media status", exact: true })
    .click();
  await section
    .getByText("Processing: ready · Stage: ready · Attempts: 2", {
      exact: true,
    })
    .waitFor();
  assert.notEqual((await api(path)).body.derivative.id, before.id);
  pass(
    "a missing derivative produces a recoverable preview error; explicit revision-guarded retry rebuilds a distinct immutable MP3",
  );
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page
    .getByRole("button", { name: "Manage audio for MP3 voice", exact: true })
    .click();
  await section.getByText(/Processing: ready/).waitFor();
  await mp3.evaluate((a) => a.play());
  await page.waitForFunction(
    () =>
      document.querySelector(
        'audio[aria-label="Private MP3 preview for MP3 voice"]',
      )?.currentTime > 0.03,
  );
  await mp3.evaluate((a) => a.pause());
  const cached = await page.evaluate(async () => {
    const hits = [];
    for (const key of await caches.keys())
      for (const r of await (await caches.open(key)).keys())
        if (new URL(r.url).pathname.startsWith("/api/creator"))
          hits.push(r.url);
    return hits;
  });
  assert.deepEqual(cached, []);
  assert.equal((await api(`/stories/${id}`)).status, 404);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText(/Sign in with an active creator account/).waitFor();
  assert.equal(await page.locator('audio[aria-label^="Private"]').count(), 0);
  assert.equal((await api(`${path}/${source.id}/derivative`)).status, 401);
  assert.deepEqual(errors, []);
  pass(
    "refresh preserves ready output, a controlling PWA never caches private bytes, mobile fits and logout removes private previews",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} processing browser checks passed (${kind}).`,
  );
} catch (e) {
  await captureBrowserFailure(page, "processing");
  throw e;
} finally {
  release?.();
  await browser?.close();
  await worker?.close();
  try {
    await queue?.obliterate({ force: true });
  } catch {}
  await queue?.close();
  await new Promise((r) => server.close(r));
  await f.close();
  await rm(dir, { recursive: true, force: true });
}
