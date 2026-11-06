// Opt-in: real provider APIs, BullMQ jobs, PostgreSQL/Redis and browser MP3/offline.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import {
  mediaQueue,
  startMediaWorker,
  enqueueCatalogMedia,
} from "../server/media/queue.js";
import { enqueueLibrivoxImports } from "../server/catalog/import.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL)
  throw Error("Use disposable TEST_DATABASE_URL and TEST_REDIS_URL");
const prefix = "catalog-live-" + randomUUID(),
  redis = redisInfrastructure(process.env.TEST_REDIS_URL, { prefix }),
  f = await fixture("postgres", {
    redis,
    config: { catalogCacheEnabled: true },
  }),
  config = { redisUrl: process.env.TEST_REDIS_URL, redisPrefix: prefix },
  queue = mediaQueue(config),
  worker = startMediaWorker(f.db, config);
let server,
  browser,
  checks = 0;
const results = {
  date: new Date().toISOString(),
  source:
    "Real LibriVox + Internet Archive APIs and audio; isolated local PostgreSQL schema/Redis namespace",
  checks: [],
};
function pass(message) {
  results.checks.push(message);
  console.log(`PASS ${++checks}: ${message}`);
}
async function until(fn, attempts = 600) {
  for (let n = 0; n < attempts; n++) {
    if (await fn()) return;
    await delay(250);
  }
  throw Error("Live catalog check timed out");
}
try {
  await redis.client.connect();
  await worker.waitUntilReady();
  await enqueueLibrivoxImports(f.db, queue);
  await enqueueCatalogMedia(f.db, queue);
  await until(async () => {
    const count = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    if (count.failed) {
      const failed = await queue.getJobs(["failed"], 0, 20);
      throw Error(
        "Live import failed: " +
          failed.map((j) => j.id + " " + j.failedReason).join(","),
      );
    }
    return !count.waiting && !count.active && !count.delayed;
  });
  const count = await f.db
    .prepare("SELECT COUNT(*) AS n FROM story_sources")
    .get();
  assert.equal(count.n, 10);
  const chapters = await f.db
    .prepare("SELECT COUNT(*) AS n FROM chapter_sources")
    .get();
  assert.equal(chapters.n, 212);
  results.books = count.n;
  results.externalChapters = chapters.n;
  results.streamOnlyChapters = (
    await f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM chapter_sources WHERE byte_length>26214400",
      )
      .get()
  ).n;
  results.jobs = await queue.getJobCounts("completed", "failed");
  pass(
    "actual BullMQ worker imports 10 real audiobooks / 212 chapters and processes the 12 original WAVs",
  );
  server = f.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const all = await fetch(base + "/api/stories").then((r) => r.json());
  assert.equal(all.total, 16);
  const alice = all.stories.find((s) => s.id === 1200);
  assert.equal(alice.content_source, "librivox");
  const first = (
    await fetch(base + "/api/stories/1200/chapters").then((r) => r.json())
  ).chapters[0];
  results.sample = { title: alice.title, chapter: first.title, id: first.id };
  await fetch(base + "/api/stories");
  assert.ok(redis.cacheStats().hits > 0);
  results.cache = redis.cacheStats();
  pass(
    "PostgreSQL serves all 16 stories with attribution and Redis cache hits; browsing does not query the content provider",
  );
  const samples = await f.db
    .prepare(
      "SELECT cs.chapter_id FROM chapter_sources cs JOIN chapters c ON c.id=cs.chapter_id WHERE c.chapter_number=1 ORDER BY c.story_id",
    )
    .all();
  results.rangeProbeRetries = 0;
  for (const sample of samples) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(
          base + `/api/chapters/${sample.chapter_id}/stream`,
          {
            headers: { Range: "bytes=0-99" },
            signal: AbortSignal.timeout(30000),
          },
        );
        assert.equal(r.status, 206);
        assert.equal((await r.arrayBuffer()).byteLength, 100);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        results.rangeProbeRetries++;
        console.log(
          `Archive probe retry for chapter ${sample.chapter_id}: ${error.cause?.code || error.name}`,
        );
        await delay(1000 * (attempt + 1));
      }
    }
  }
  pass(
    "the first chapter of every imported book returns real 206 audio bytes from Internet Archive",
  );
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/stories/1200");
  await page.getByRole("heading", { name: alice.title, exact: true }).waitFor();
  await page.getByRole("link", { name: "Source: LibriVox" }).waitFor();
  const start = performance.now();
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1,
  );
  results.clickToAudioPastOneSecondMs = Math.round(performance.now() - start);
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.waitForFunction(
    async () =>
      (await fetch("/api/progress").then((r) => r.json())).progress[0]
        ?.position_seconds > 0.5,
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 0.5,
  );
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  pass(
    "real external MP3 decodes and the paused chapter position restores after refresh",
  );
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page
    .getByRole("button", { name: `Download ${first.title}`, exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `Remove download of ${first.title}`,
      exact: true,
    })
    .waitFor();
  await page.goto(base + "/downloads");
  await page
    .getByRole("button", {
      name: `Play downloaded ${first.title}`,
      exact: true,
    })
    .waitFor();
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", {
      name: `Play downloaded ${first.title}`,
      exact: true,
    })
    .click();
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > 0.5;
  });
  const range = await page.evaluate(async (path) => {
    const r = await fetch(path, { headers: { Range: "bytes=5000-5015" } });
    return {
      status: r.status,
      type: r.headers.get("Content-Type"),
      size: (await r.arrayBuffer()).byteLength,
    };
  }, first.audio_url);
  assert.deepEqual(range, { status: 206, type: "audio/mpeg", size: 16 });
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `Remove download of ${first.title}`,
      exact: true,
    })
    .click();
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    0,
  );
  assert.deepEqual(errors, []);
  pass(
    "the real MP3 downloads across origins, reloads and plays offline, serves MPEG seek ranges and is removable",
  );
  await context.setOffline(false);
  // Exercise the storage accounting without allocating 200 MB in a test profile.
  await page.evaluate(async () => {
    const c = await caches.open("soundwave-audio-v1");
    await c.put(
      "/test-download-budget",
      new Response("budget fixture", {
        headers: { "Content-Length": String(200 * 1024 * 1024) },
      }),
    );
  });
  await page.goto(base + "/stories/1200");
  await page
    .getByRole("button", { name: `Download ${first.title}`, exact: true })
    .click();
  await page
    .getByText(
      "Download failed: The 200 MB download limit is reached. Remove a chapter first.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    1,
  );
  await page.evaluate(async () => {
    await (
      await caches.open("soundwave-audio-v1")
    ).delete("/test-download-budget");
  });
  assert.deepEqual(errors, []);
  pass(
    "the 200 MB aggregate admission limit rejects another download without publishing partial audio (size-header fixture)",
  );
  results.passed = checks;
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.close();
  await f.close();
}
