import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { openDatabase, seedDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
const directory = mkdtempSync(join(tmpdir(), "soundwave-offline-"));
const db = openDatabase(join(directory, "demo.sqlite"));
seedDatabase(db);
const server = createApp(db).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser,
  page,
  checks = 0;
const check = (name) => {
  checks++;
  console.log(`PASS ${checks}: ${name}`);
};
try {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (existsSync(macChrome) ? macChrome : undefined),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${url}/offline.html`);
  await page.evaluate(() => caches.open("soundwave-shell-v0"));
  await page.goto(`${url}/stories/1`);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page
    .getByRole("button", {
      name: "Download A voice in the static",
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".download-button")?.disabled,
  );
  assert.ok(
    !(await page.evaluate(() => caches.keys())).includes("soundwave-shell-v0"),
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    0,
  );
  const manifest = await page.evaluate(async () =>
    fetch("/manifest.webmanifest").then((r) => r.json()),
  );
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 2);
  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send("Page.getAppManifest");
  assert.deepEqual(appManifest.errors, []);
  check(
    "manifest parses, service worker controls the app, stale shell cache is removed, and no audio is automatically cached",
  );
  await page
    .getByRole("button", {
      name: "Download A voice in the static",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  const saved = await page.evaluate(async () => {
    const cache = await caches.open("soundwave-audio-v1");
    const keys = await cache.keys();
    const response = await cache.match(keys[0]);
    return {
      count: keys.length,
      status: response.status,
      size: (await response.arrayBuffer()).byteLength,
      range: response.headers.get("Content-Range"),
    };
  });
  assert.equal(saved.count, 1);
  assert.equal(saved.status, 200);
  assert.equal(saved.range, null);
  assert.equal(
    saved.size,
    statSync(new URL("../server/public/audio/1-1.wav", import.meta.url)).size,
  );
  check(
    "explicit download stores exactly one complete 200 response, matching the file size",
  );
  await page
    .getByRole("combobox", { name: "Playback speed", exact: true })
    .selectOption("1.5");
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Playback speed"]')?.value ===
      "1.5",
  );
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 0.5,
  );
  assert.equal(
    await page.locator("audio").evaluate((a) => a.playbackRate),
    1.5,
  );
  check("preferred playback speed survives reload and applies to real audio");
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("audio").paused);
  const before = await page.locator("audio").evaluate((a) => a.currentTime);
  await page.keyboard.press("ArrowRight");
  assert.ok(
    (await page.locator("audio").evaluate((a) => a.currentTime)) >=
      before + 9.9,
  );
  const search = page.getByRole("textbox", {
    name: "Search story titles or genres",
  });
  await search.focus();
  await search.press("Space");
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  check("keyboard pause/seek work and typing does not trigger playback");
  await page
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.clock.install();
  await page
    .getByRole("combobox", { name: "Sleep timer", exact: true })
    .selectOption("5");
  await page.clock.fastForward(300000);
  await page.waitForFunction(() => document.querySelector("audio").paused);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Sleep timer", exact: true })
      .inputValue(),
    "0",
  );
  check(
    "five-minute sleep timer pauses actual media and resets its UI (browser clock advanced)",
  );
  // Isolate the accelerated-clock scenario from real networking in a fresh tab.
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${url}/downloads`);
  await page
    .getByRole("button", {
      name: "Play downloaded A voice in the static",
      exact: true,
    })
    .waitFor();
  await context.setOffline(true);
  await page.reload();
  await page
    .getByText(
      "You’re offline. Downloaded chapters can play; saving progress needs a connection.",
    )
    .waitFor();
  await page
    .getByRole("button", {
      name: "Play downloaded A voice in the static",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () => {
      const a = document.querySelector("audio");
      return a && !a.paused && a.currentTime > 0.5;
    },
    {},
    { timeout: 15000 },
  );
  check(
    "with Chrome network disabled, the cached app reloads and a downloaded chapter actually plays",
  );
  const ranges = await page.evaluate(async () => {
    const r = await fetch("/api/chapters/101/stream", {
      headers: { Range: "bytes=5000-5015" },
    });
    const bad = await fetch("/api/chapters/101/stream", {
      headers: { Range: "bytes=99999999-" },
    });
    return {
      status: r.status,
      length: (await r.arrayBuffer()).byteLength,
      range: r.headers.get("Content-Range"),
      bad: bad.status,
    };
  });
  assert.equal(ranges.status, 206);
  assert.equal(ranges.length, 16);
  assert.match(ranges.range, /^bytes 5000-5015\//);
  assert.equal(ranges.bad, 416);
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.evaluate(() => document.activeElement.blur());
  const offlineBefore = await page
    .locator("audio")
    .evaluate((a) => a.currentTime);
  await page.keyboard.press("ArrowRight");
  assert.ok(
    (await page.locator("audio").evaluate((a) => a.currentTime)) >=
      offlineBefore + 9.9,
  );
  check("downloaded audio supports 206/416 byte ranges and offline seeking");
  assert.equal(
    await page.evaluate(
      async () => (await fetch("/api/chapters/102/stream")).status,
    ),
    503,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    1,
  );
  check(
    "undownloaded chapters stay unavailable offline and are not silently cached",
  );
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "A story for the road", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    0,
  );
  check("remove-download works offline and deletes the cached file");
  await context.setOffline(false);
  await page.goto(`${url}/stories/1`);
  await page.waitForFunction(
    () => !document.querySelector(".download-button")?.disabled,
  );
  await page.evaluate(() => {
    window.originalCachePut = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      if (String(request).includes("/stream"))
        return Promise.reject(new DOMException("Full", "QuotaExceededError"));
      return window.originalCachePut.call(this, request, response);
    };
  });
  await page
    .getByRole("button", {
      name: "Download A voice in the static",
      exact: true,
    })
    .click();
  await page
    .getByText("Browser storage is full. Remove a download and try again.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    0,
  );
  check(
    "storage quota failure is surfaced without publishing a partial download",
  );
  assert.deepEqual(errors, []);
  check("no uncaught JavaScript errors during player/offline scenarios");
  console.log(
    `\n${checks} advanced player / PWA / offline browser checks passed.`,
  );
} catch (error) {
  console.error(
    "OFFLINE DEBUG",
    await page
      ?.evaluate(() => ({
        url: location.href,
        online: navigator.onLine,
        body: document.body.innerText,
        html: document.documentElement.outerHTML.slice(0, 1200),
        controlled: Boolean(navigator.serviceWorker.controller),
      }))
      .catch(() => null),
  );
  await page
    ?.screenshot({
      path: "/private/tmp/soundwave-offline-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
