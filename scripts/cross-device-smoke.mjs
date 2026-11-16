import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";
for (const value of [
  process.env.TEST_DATABASE_URL,
  process.env.TEST_REDIS_URL,
].filter(Boolean))
  if (!["127.0.0.1", "localhost"].includes(new URL(value).hostname))
    throw Error("Use disposable loopback test services only");
const redis = process.env.TEST_REDIS_URL
  ? redisInfrastructure(process.env.TEST_REDIS_URL, {
      prefix: "sync-browser-" + randomUUID(),
    })
  : undefined;
if (redis) await redis.client.connect();
const f = await fixture(kind, { redis }),
  server = f.app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`,
  results = {
    date: new Date().toISOString(),
    database: kind,
    redis: !!redis,
    checks: [],
  },
  errors = [];
const pass = (s) => {
  results.checks.push(s);
  console.log(`PASS ${results.checks.length}: ${s}`);
};
let browser, a, b;
const get = (page) =>
  page.evaluate(() =>
    fetch("/api/progress/101")
      .then((r) => r.json())
      .then((d) => d.progress),
  );
const write = (page, body) =>
  page.evaluate(async (body) => {
    const session = await fetch("/api/auth/session").then((r) => r.json());
    const r = await fetch("/api/progress/101", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }, body);
const body = (revision, position, extra = {}) => ({
  expectedRevision: revision,
  positionSeconds: position,
  clientId: randomUUID(),
  sequence: 1,
  ...extra,
});
const conflict = (page) =>
  page.getByRole("alert", { name: "Playback progress conflict" });
const nav = (page, path) =>
  page.evaluate((path) => {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
const refresh = async (page) => {
  await page
    .getByRole("button", { name: "Refresh Progress", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Refresh Progress", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh Progress", exact: true })
    .waitFor();
};
async function seek(page, value, status = 200) {
  const ack = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.status() === status,
  );
  await page
    .getByRole("slider", { name: "Playback position", exact: true })
    .evaluate((input, value) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  return ack;
}
async function signup(page, email) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const p = page.getByRole("region", { name: "Your account" });
  await p.getByLabel("Name", { exact: true }).fill("Sync listener");
  await p.getByLabel("Email", { exact: true }).fill(email);
  await p
    .getByLabel("Password", { exact: true })
    .fill("cross device browser password!");
  await p.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  a = await ca.newPage();
  b = await cb.newPage();
  for (const page of [a, b]) {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push(e.message));
  }
  const email = `sync-${randomUUID()}@example.com`;
  await a.goto(base + "/stories/1");
  await signup(a, email);
  assert.equal((await write(a, body(0, 10))).status, 200);
  await a.reload();
  await a.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 9.5 &&
      document.querySelector("audio").paused,
  );
  await b.goto(base + "/stories/1");
  await b.getByRole("button", { name: "Sign in", exact: true }).click();
  const panel = b.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel
    .getByLabel("Password", { exact: true })
    .fill("cross device browser password!");
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await b.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await b.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 9.5 &&
      document.querySelector("audio").paused,
  );
  assert.equal((await get(a)).revision, (await get(b)).revision);
  pass(
    "two independent authenticated browser contexts restore the same account revision paused",
  );
  let state = await get(a);
  assert.equal((await write(a, body(state.revision, 20))).status, 200);
  await refresh(a);
  await a.waitForFunction(
    () =>
      Math.abs(document.querySelector("audio").currentTime - 20) < 0.2 &&
      document.querySelector("audio").paused,
  );
  await seek(b, 5, 409);
  await conflict(b).waitFor();
  assert.equal((await get(b)).position_seconds, 20);
  assert.ok(
    Math.abs(
      (await b.evaluate(() => document.querySelector("audio").currentTime)) - 5,
    ) < 0.2,
  );
  await b.getByRole("button", { name: "Resume Latest", exact: true }).click();
  await b.waitForFunction(
    () =>
      Math.abs(document.querySelector("audio").currentTime - 20) < 0.2 &&
      document.querySelector("audio").paused,
  );
  pass(
    "a stale device cannot rewind accepted state; Resume Latest applies it paused",
  );
  await seek(b, 4);
  state = await get(b);
  assert.equal(state.position_seconds, 4);
  await refresh(a);
  await a.waitForFunction(
    () =>
      Math.abs(document.querySelector("audio").currentTime - 4) < 0.2 &&
      document.querySelector("audio").paused,
  );
  pass(
    "a deliberate rewind with the acknowledged revision persists and clean foreground refresh stays paused",
  );
  await a
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await a.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 4.3 &&
      !document.querySelector("audio").paused,
  );
  state = await get(b);
  assert.equal((await write(b, body(state.revision, 18))).status, 200);
  await refresh(a);
  await conflict(a).waitFor();
  const local = await a.evaluate(
    () => document.querySelector("audio").currentTime,
  );
  assert.ok(local < 10);
  const keepAck = a.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await a
    .getByRole("button", { name: "Keep My Position", exact: true })
    .click();
  await keepAck;
  assert.equal(
    await a.evaluate(() => document.querySelector("audio").paused),
    false,
  );
  assert.ok((await get(a)).position_seconds < 10);
  const pauseAck = a.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await a
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await pauseAck;
  pass(
    "active foreground synchronization does not jump audio; Keep My Position is an explicit conditional write",
  );
  state = await get(a);
  const duration = await a.evaluate(
    () => document.querySelector("audio").duration,
  );
  assert.equal(
    (await write(a, body(state.revision, duration, { completed: true })))
      .status,
    200,
  );
  await seek(b, 6, 409);
  await conflict(b).waitFor();
  const resetAck = b.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok() &&
      r.request().postDataJSON().action === "reset",
  );
  await b
    .getByRole("button", { name: "Keep My Position", exact: true })
    .click();
  await resetAck;
  assert.equal((await get(b)).completed, false);
  assert.equal(
    (
      await b.evaluate(() =>
        fetch("/api/analytics/overview").then((r) => r.json()),
      )
    ).recentActivity.filter((e) => e.event_type === "chapter_completed").length,
    1,
  );
  pass(
    "remote completion rejects an old device; explicit keep/reset reopens progress without erasing or duplicating completion analytics",
  );
  await refresh(a);
  if (await conflict(a).count())
    await a.getByRole("button", { name: "Resume Latest", exact: true }).click();
  // Ensure a clean paused baseline, then publish a downloaded chapter before offline playback.
  await a.reload();
  await a.waitForFunction(
    () =>
      document.querySelector("audio")?.readyState >= 2 &&
      !document.querySelector("audio").seeking,
  );
  const download = a.getByRole("button", {
    name: "Download A voice in the static",
    exact: true,
  });
  await download.waitFor();
  await a.waitForFunction(
    () => !document.querySelector(".download-button")?.disabled,
  );
  await download.click();
  await a
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  await a.reload();
  await a.waitForFunction(
    () =>
      document.querySelector("audio")?.readyState >= 2 &&
      !document.querySelector("audio").seeking,
  );
  state = await get(b);
  assert.equal((await write(b, body(state.revision, 20))).status, 200);
  if (redis) {
    redis.client.destroy();
    await refresh(a);
    await a
      .getByRole("alert")
      .filter({ hasText: /Progress refresh failed/ })
      .waitFor();
    pass(
      "real Redis disconnection rejects private synchronization without changing accepted progress",
    );
  }
  await ca.setOffline(true);
  await a
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await a.waitForFunction(() => !document.querySelector("audio").paused);
  await a
    .getByRole("slider", { name: "Playback position", exact: true })
    .evaluate((input) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, "4");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await a
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await a
    .getByRole("alert")
    .filter({ hasText: /not synchronized/ })
    .waitFor();
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT position_seconds FROM listening_progress WHERE chapter_id=101 AND user_id=?",
        )
        .get(
          (await f.db.prepare("SELECT id FROM users WHERE email=?").get(email))
            .id,
        )
    ).position_seconds,
    20,
  );
  if (redis) await redis.client.connect();
  await ca.setOffline(false);
  await refresh(a);
  await conflict(a).waitFor();
  assert.ok(
    Math.abs(
      (await a.evaluate(() => document.querySelector("audio").currentTime)) - 4,
    ) < 0.5,
  );
  const reconnectAck = a.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok(),
  );
  await a
    .getByRole("button", { name: "Keep My Position", exact: true })
    .click();
  await reconnectAck;
  assert.ok(Math.abs((await get(a)).position_seconds - 4) < 0.5);
  pass(
    "downloaded audio works during Redis/network loss; reconnect conflicts preserve local position until an explicit decision",
  );
  state = await get(a);
  const p1 = body(state.revision, 7),
    p2 = body(state.revision, 9);
  const race = await Promise.all([write(a, p1), write(b, p2)]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? p1 : p2;
  const retry = await write(a, winner);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(
    retry.body.progress.revision,
    race.find((r) => r.status === 200).body.progress.revision,
  );
  assert.equal(
    (await write(b, { ...winner, positionSeconds: 3 })).body.error.code,
    "PROGRESS_IDENTITY_REUSED",
  );
  pass(
    "real contexts racing one revision have one winner; exact retries acknowledge once and changed identity payloads fail",
  );
  await refresh(a);
  if (await conflict(a).count())
    await a.getByRole("button", { name: "Resume Latest", exact: true }).click();
  // Delay a completed old-account GET at the fetch boundary, not with a timer.
  await a.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const response = await original(input, options);
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      if (
        path === "/api/progress/101" &&
        (!options?.method || options.method === "GET")
      )
        await new Promise((r) => {
          window.syncRelease = r;
        });
      return response;
    };
  });
  const readAck = a.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "GET" &&
      r.ok(),
  );
  await a
    .getByRole("button", { name: "Refresh Progress", exact: true })
    .click();
  await readAck;
  await a.getByRole("button", { name: "Sign out", exact: true }).click();
  await a.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await signup(a, `other-${randomUUID()}@example.com`);
  await a.evaluate(() => window.syncRelease());
  await nav(a, "/queue");
  await a
    .getByText("No current chapter. Add chapters from a story or playlist.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await conflict(a).count(), 0);
  assert.equal(
    await a.evaluate(() => sessionStorage.getItem("soundwave.queue.v1")),
    null,
  );
  pass(
    "an old account's delayed synchronization result cannot restore private player/queue state after account switching",
  );
  const privateCached = await a.evaluate(async () => {
    const found = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        if (
          /^\/api\/(progress|auth|analytics|library|playlists|profile|settings)(\/|$)/.test(
            new URL(request.url).pathname,
          )
        )
          found.push(new URL(request.url).pathname);
    return found;
  });
  assert.deepEqual(privateCached, []);
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.deepEqual(errors, []);
  pass(
    "mobile layout and uncaught-error checks pass; synchronization never autoplays restored account progress",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} cross-device browser checks passed (${kind}).`,
  );
} catch (e) {
  await captureBrowserFailure(a, "cross-device");
  throw e;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
  await redis?.close();
}
