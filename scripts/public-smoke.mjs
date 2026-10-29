// Run against an explicitly supplied demo URL. Uses an isolated browser profile/cache.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
const base = new URL(
  process.argv[2] || "https://soundwave-codeit-ronit.vercel.app",
).origin;
let checks = 0,
  browser;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  for (const [name, path, method, headers, status] of [
    ["homepage", "/", "GET", {}, 200],
    ["SPA deep link", "/stories/1", "GET", {}, 200],
    ["health", "/api/health", "GET", {}, 200],
    ["HEAD", "/api/chapters/101/stream", "HEAD", {}, 200],
    [
      "valid range",
      "/api/chapters/101/stream",
      "GET",
      { Range: "bytes=0-99" },
      206,
    ],
    [
      "unsatisfiable range",
      "/api/chapters/101/stream",
      "GET",
      { Range: "bytes=99999999-" },
      416,
    ],
  ]) {
    const response = await fetch(base + path, { method, headers });
    assert.equal(response.status, status, name);
    if (name === "valid range") {
      assert.equal((await response.arrayBuffer()).byteLength, 100);
      assert.match(response.headers.get("Content-Range"), /^bytes 0-99\//);
    } else await response.arrayBuffer();
  }
  pass(
    "public HTTPS homepage, SPA route, API, HEAD and 206/416 responses work without login",
  );
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const submitted = "https://zippy-nitrogen-wd3scr3.tmp.now/";
  await page.goto(
    base.includes("soundwave-codeit-ronit.vercel.app") ? submitted : base,
  );
  assert.equal(new URL(page.url()).origin, base);
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      const a = document.querySelector("audio");
      return a && !a.paused && a.readyState >= 2;
    },
    {},
    { timeout: 25000 },
  );
  const snapshot = await page
    .locator("audio")
    .evaluate((a) => ({ time: a.currentTime, src: a.src }));
  await page.waitForFunction(
    ({ time, src }) => {
      const a = document.querySelector("audio");
      return (
        a &&
        !a.paused &&
        ((a.src === src && a.currentTime > time + 0.5) ||
          (a.src !== src && a.currentTime > 0.5))
      );
    },
    snapshot,
    { timeout: 15000 },
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  pass(
    "the submitted resume URL redirects to this deployment and real decoded audio time advances",
  );
  await page.goto(base + "/stories/1");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const save = page.getByRole("button", {
    name: "Download A voice in the static",
    exact: true,
  });
  await save.waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".download-button")?.disabled,
  );
  await save.click();
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  const cached = await page.evaluate(async () => {
    const c = await caches.open("soundwave-audio-v1");
    const keys = await c.keys();
    const r = await c.match(keys[0]);
    return {
      count: keys.length,
      status: r.status,
      partial: r.headers.has("Content-Range"),
    };
  });
  assert.deepEqual(cached, { count: 1, status: 200, partial: false });
  pass(
    "the HTTPS deployment registers its worker and downloads one complete selected chapter",
  );
  await page
    .getByRole("link", { name: "Downloads", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Play downloaded A voice in the static",
      exact: true,
    })
    .waitFor();
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Play downloaded A voice in the static",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () => {
      const a = document.querySelector("audio");
      return a && !a.paused && a.readyState >= 2;
    },
    {},
    { timeout: 20000 },
  );
  const offlineTime = await page
    .locator("audio")
    .evaluate((a) => a.currentTime);
  await page.waitForFunction((t) => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > t + 0.5;
  }, offlineTime);
  const range = await page.evaluate(async () => {
    const r = await fetch("/api/chapters/101/stream", {
      headers: { Range: "bytes=4000-4099" },
    });
    return { status: r.status, length: (await r.arrayBuffer()).byteLength };
  });
  assert.deepEqual(range, { status: 206, length: 100 });
  pass(
    "deployed app reloads offline and plays downloaded audio with range support",
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
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
  pass("download removal works offline on the public deployment");
  console.log(`\n${checks} public deployment smoke checks passed for ${base}`);
} finally {
  if (browser) await browser.close();
}
