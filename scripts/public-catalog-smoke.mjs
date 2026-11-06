// Owned public demo only. Creates one isolated, expiring verification guest.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
const base = "https://soundwave-codeit-ronit.vercel.app";
const results = {
  date: new Date().toISOString(),
  origin: base,
  checks: [],
  catalogHttpMs: [],
};
let browser;
const pass = (message) => {
  results.checks.push(message);
  console.log(`PASS ${results.checks.length}: ${message}`);
};
try {
  let all;
  for (let n = 0; n < 5; n++) {
    const start = performance.now();
    const r = await fetch(base + "/api/stories");
    assert.equal(r.status, 200);
    all = await r.json();
    results.catalogHttpMs.push(Math.round(performance.now() - start));
  }
  assert.equal(all.total, 16);
  assert.equal(
    all.stories.filter((s) => s.content_source === "librivox").length,
    10,
  );
  const book = all.stories.find((s) => s.id === 1200);
  assert.ok(book.narrator);
  assert.ok(book.source_url.startsWith("https://librivox.org/"));
  const chapters = await fetch(base + "/api/stories/1200/chapters").then((r) =>
      r.json(),
    ),
    first = chapters.chapters[0];
  assert.equal(chapters.chapters.length, 12);
  pass(
    "public PostgreSQL catalog serves 16 stories, including 10 credited LibriVox books with real chapters",
  );
  const ranged = await fetch(base + first.audio_url, {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.equal(
    (
      await fetch(base + first.audio_url, {
        headers: { Range: "bytes=999999999-" },
      })
    ).status,
    416,
  );
  assert.equal(
    (await fetch(base + first.audio_url, { method: "HEAD" })).headers.get(
      "content-type",
    ),
    "audio/mpeg",
  );
  pass("external chapter ranges and HEAD work through the existing public URL");
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/stories/1200");
  await page.getByRole("link", { name: "Source: LibriVox" }).waitFor();
  const guest = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  results.testUserId = guest.user.id;
  assert.equal(guest.user.kind, "guest");
  await page
    .getByRole("button", {
      name: `Add ${book.title} to your library`,
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: `Remove ${book.title} from your library`,
      exact: true,
    })
    .first()
    .waitFor();
  const started = performance.now();
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1.2,
  );
  results.clickToAudioPastOneSecondMs = Math.round(performance.now() - started);
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    async () =>
      (await fetch("/api/progress").then((r) => r.json())).progress[0]
        ?.position_seconds > 10,
    {},
    { polling: 250 },
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 10,
  );
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  assert.equal(
    (await page.evaluate(() => fetch("/api/library").then((r) => r.json())))
      .stories[0].id,
    1200,
  );
  const analytics = await page.evaluate(() =>
    fetch("/api/analytics/overview").then((r) => r.json()),
  );
  assert.ok(analytics.totalListeningSeconds < 10);
  results.recordedListeningSeconds = analytics.totalListeningSeconds;
  pass(
    "real MP3 plays and seeks; external favorites/resume persist and a 10-second seek does not become listening time",
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
  const range = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: "bytes=5000-5015" } });
    return {
      status: r.status,
      type: r.headers.get("Content-Type"),
      bytes: (await r.arrayBuffer()).byteLength,
    };
  }, first.audio_url);
  assert.deepEqual(range, { status: 206, type: "audio/mpeg", bytes: 16 });
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
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  pass(
    "the deployed MP3 downloads, reloads/plays offline, supports MPEG byte seeking and is removable without browser exceptions",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.locator("#browse .story-card").first().waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  pass(
    "the expanded public catalog fits the mobile viewport without horizontal overflow",
  );
  results.passed = results.checks.length;
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log("Verification guest for operator cleanup:", results.testUserId);
} finally {
  await browser?.close();
}
