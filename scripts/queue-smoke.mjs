import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
import { waitForProgressSave } from "./browser-sync.mjs";
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";
if (
  process.env.TEST_DATABASE_URL &&
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.TEST_DATABASE_URL).hostname,
  )
)
  throw Error("Only disposable loopback databases allowed");
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
  page.on("requestfailed", (r) => {
    if (
      new URL(r.url()).pathname.endsWith("/stream") &&
      r.failure()?.errorText !== "net::ERR_ABORTED"
    )
      console.log(
        "STREAM_FAILURE",
        new URL(r.url()).pathname,
        r.failure()?.errorText,
      );
  });
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.endsWith("/stream") && r.status() >= 400)
      console.log("STREAM_STATUS", r.status(), new URL(r.url()).pathname);
  });
  const nav = async (path) => {
    await page.evaluate((path) => {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  };
  const queue = () => page.getByRole("region", { name: "Playback queue" });
  const stored = () =>
    page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("soundwave.queue.v1")),
    );
  await page.goto(base + "/stories/1");
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 0.5,
  );
  const catalog = await page.evaluate(async () => ({
    one: (await fetch("/api/stories/1/chapters").then((r) => r.json()))
      .chapters,
    two: (await fetch("/api/stories/2/chapters").then((r) => r.json()))
      .chapters,
  }));
  await nav("/stories/2");
  await page
    .getByRole("button", {
      name: `Play next: ${catalog.two[0].title}`,
      exact: true,
    })
    .click();
  await page.getByText("Playing next", { exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: `Add to queue: ${catalog.two[0].title}`,
      exact: true,
    })
    .click();
  await page.getByText("Added to queue", { exact: true }).waitFor();
  await page.getByRole("link", { name: /^Queue \(/ }).click();
  const q = queue();
  await q.getByRole("heading", { name: /Up next/ }).waitFor();
  const first = await stored();
  assert.equal(first.upcoming[0].chapterId, 201);
  assert.equal(first.upcoming.at(-1).chapterId, 201);
  assert.notEqual(first.upcoming[0].id, first.upcoming.at(-1).id);
  pass(
    "chapter Play Next/Add to Queue creates distinct cross-story occurrences without interrupting playback",
  );
  await q
    .getByRole("button", { name: "Move queue item 1 down", exact: true })
    .click();
  assert.equal((await stored()).upcoming[1].chapterId, 201);
  await q
    .getByRole("button", { name: "Move queue item 2 up", exact: true })
    .click();
  await q
    .getByRole("button", {
      name: `Remove queue item ${first.upcoming.length}: ${catalog.two[0].title}`,
      exact: true,
    })
    .click();
  assert.equal(
    (await stored()).upcoming.filter((e) => e.chapterId === 201).length,
    1,
  );
  const paused = waitForProgressSave(
    page,
    (p) => p.chapter_id === 101 && !p.completed,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await paused;
  const snapshot = await stored();
  await page.reload();
  await q.getByRole("heading", { name: /Up next/ }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0 &&
      document.querySelector("audio").paused,
  );
  const restored = await stored();
  assert.deepEqual(restored.upcoming, snapshot.upcoming);
  assert.equal(restored.current.id, snapshot.current.id);
  pass(
    "reorder/removal target occurrence IDs; refresh restores current position and order paused",
  );
  await nav("/settings");
  await page.getByLabel("Automatically play the next chapter").uncheck();
  await page
    .getByRole("button", { name: "Save playback preferences", exact: true })
    .click();
  await page
    .getByText("Playback preferences saved.", { exact: true })
    .waitFor();
  await nav("/queue");
  await page
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  const complete = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok() &&
      JSON.parse(r.request().postData()).completed,
  );
  await page.evaluate(() => {
    const a = document.querySelector("audio");
    a.currentTime = a.duration - 0.1;
  });
  await complete;
  await page.waitForFunction(() => document.querySelector("audio")?.ended);
  assert.equal((await stored()).current.chapterId, 101);
  await q.getByRole("button", { name: "Skip to next", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.src.includes("201/stream") &&
      !document.querySelector("audio").paused,
  );
  pass(
    "autoplay-off persists completion without consuming the queue; manual Next crosses stories",
  );
  await q
    .getByRole("button", { name: "Clear upcoming queue", exact: true })
    .click();
  await q.getByRole("button", { name: "Keep queue", exact: true }).click();
  assert.ok((await stored()).upcoming.length);
  await q
    .getByRole("button", { name: "Clear upcoming queue", exact: true })
    .click();
  await q
    .getByRole("button", { name: "Confirm clear upcoming", exact: true })
    .click();
  assert.equal((await stored()).upcoming.length, 0);
  assert.equal(
    await page.evaluate(() => document.querySelector("audio").paused),
    false,
  );
  pass("clear requires confirmation and leaves current audio playing");
  await nav("/stories/2");
  await page
    .getByRole("button", {
      name: `Add to queue: ${catalog.two[0].title}`,
      exact: true,
    })
    .click();
  await page.getByText("Added to queue", { exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: `Add to queue: ${catalog.two[1].title}`,
      exact: true,
    })
    .click();
  await page.getByText("Added to queue", { exact: true }).last().waitFor();
  await nav("/queue");
  await q.getByRole("button", { name: "Skip to next", exact: true }).click();
  await q.getByRole("button", { name: "Skip to next", exact: true }).click();
  assert.equal((await stored()).current.chapterId, 202);
  assert.equal((await stored()).upcoming.length, 0);
  pass(
    "successive browser Next actions consume distinct queued occurrences without duplicate or skipped selections",
  );

  // Add a genuine private playlist and enqueue its story through the shared card.
  await nav("/library");
  const lists = page.getByRole("region", { name: "Private playlists" });
  await lists
    .getByLabel("Playlist name", { exact: true })
    .fill("Queue fixture");
  await lists
    .getByRole("button", { name: "Create playlist", exact: true })
    .click();
  await lists
    .getByRole("heading", { name: "Queue fixture", exact: true })
    .waitFor();
  const playlistId = new URL(page.url()).searchParams.get("playlist");
  await lists.getByLabel("Story to add", { exact: true }).selectOption("1");
  await lists
    .getByRole("button", { name: "Add story to playlist", exact: true })
    .click();
  await lists
    .getByRole("button", {
      name: "Add to queue: The Midnight Frequency chapters",
      exact: true,
    })
    .click();
  await lists.getByText("Added to queue", { exact: true }).waitFor();
  assert.deepEqual(
    (await stored()).upcoming.map((e) => e.chapterId),
    catalog.one.map((c) => c.id),
  );
  const membership = await page.evaluate(
    (id) => fetch(`/api/playlists/${id}`).then((r) => r.json()),
    playlistId,
  );
  assert.deepEqual(
    membership.stories.map((s) => s.id),
    [1],
  );
  pass(
    "playlist story chapters enqueue in order while private membership/order remains unchanged",
  );
  await nav("/settings");
  await page.getByLabel("Automatically play the next chapter").check();
  await page
    .getByRole("button", { name: "Save playback preferences", exact: true })
    .click();
  await page
    .getByText("Playback preferences saved.", { exact: true })
    .waitFor();
  await nav("/queue");
  const crossComplete = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/progress/202" &&
      r.request().method() === "PUT" &&
      r.ok() &&
      JSON.parse(r.request().postData()).completed,
  );
  await page.evaluate(() => {
    const a = document.querySelector("audio");
    a.currentTime = a.duration - 0.1;
  });
  await crossComplete;
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.src.includes("101/stream") &&
      !document.querySelector("audio").paused,
  );
  assert.equal((await stored()).current.chapterId, 101);
  pass(
    "saved autoplay-on advances into the next story using the shared media element",
  );
  // Inject after page-hide persistence, before the next app bootstrap.
  await page.addInitScript(() => {
    const mode = sessionStorage.getItem("queueSmokeTamper");
    sessionStorage.removeItem("queueSmokeTamper");
    if (mode === "missing") {
      const s = JSON.parse(sessionStorage.getItem("soundwave.queue.v1"));
      s.upcoming.push({
        id: crypto.randomUUID(),
        storyId: 1,
        chapterId: 999999,
      });
      sessionStorage.setItem("soundwave.queue.v1", JSON.stringify(s));
    } else if (mode === "corrupt")
      sessionStorage.setItem("soundwave.queue.v1", "{corrupted");
  });
  await page.evaluate(() =>
    sessionStorage.setItem("queueSmokeTamper", "missing"),
  );
  await nav("/queue");
  await page.reload();
  await q.getByText(/unavailable queue entries removed/).waitFor();
  assert.equal(
    (await stored()).upcoming.some((e) => e.chapterId === 999999),
    false,
  );
  pass(
    "restoration validates current catalog references and safely prunes an unavailable chapter",
  );
  await page.evaluate(() =>
    sessionStorage.setItem("queueSmokeTamper", "corrupt"),
  );
  await page.reload();
  await q
    .getByRole("alert")
    .filter({ hasText: /invalid/ })
    .waitFor();
  await q
    .getByRole("button", { name: "Dismiss queue warning", exact: true })
    .click();
  pass(
    "corrupt storage produces a visible recovery warning without breaking playback controls",
  );
  // Storage write failures must not disable in-memory playback/editing.
  await page.evaluate(() => {
    window.queueOriginalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "soundwave.queue.v1")
        throw new DOMException("Quota", "QuotaExceededError");
      return window.queueOriginalSet.call(this, k, v);
    };
  });
  await nav("/stories/1");
  await page
    .getByRole("button", {
      name: "Add to queue: A voice in the static",
      exact: true,
    })
    .click();
  await page.getByText("Added to queue", { exact: true }).waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: /browser storage could not save/ })
    .waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.queueOriginalSet;
  });
  await nav("/queue");
  assert.ok(await q.locator(".queue-list li").count());
  pass(
    "quota failure leaves queue editing functional in memory with an explicit persistence warning",
  );
  // A real download is the only audio used during the offline checks.
  await nav("/stories/1");
  const download = page.getByRole("button", {
    name: "Download A voice in the static",
    exact: true,
  });
  await download.waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".download-button")?.disabled,
  );
  await download.click();
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  // Begin the offline phase from the persisted queue and a fresh media load,
  // Hot cache publication into an existing load remains a documented concern.
  await page.reload();
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a?.readyState >= 2 && !a.seeking;
  });
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0.5 &&
      !document.querySelector("audio").paused,
  );
  await nav("/queue");
  await q
    .getByRole("button", { name: "Clear upcoming queue", exact: true })
    .click();
  await q
    .getByRole("button", { name: "Confirm clear upcoming", exact: true })
    .click();
  await nav("/stories/1");
  await page
    .getByRole("button", {
      name: "Add to queue: A voice in the static",
      exact: true,
    })
    .click();
  await page.getByText("Added to queue", { exact: true }).waitFor();
  await nav("/queue");
  const savedPause = waitForProgressSave(
    page,
    (p) => p.chapter_id === 101 && !p.completed,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await savedPause;
  await context.setOffline(true);
  await page.reload();
  await q.getByRole("heading", { name: /Up next/ }).waitFor();
  assert.equal((await stored()).upcoming[0].chapterId, 101);
  await q.getByRole("button", { name: "Skip to next", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0.3 &&
      !document.querySelector("audio").paused,
  );
  pass(
    "offline refresh validates downloaded metadata and queued duplicate playback uses real cached audio",
  );
  await context.setOffline(false);
  await page.reload();
  await q.getByRole("heading", { name: /Up next/ }).waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Name", { exact: true }).fill("Queue listener");
  await panel
    .getByLabel("Email", { exact: true })
    .fill(`queue-${randomUUID()}@example.com`);
  await panel
    .getByLabel("Password", { exact: true })
    .fill("queue browser test password!");
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("soundwave.queue.v1")),
    null,
  );
  assert.equal(await q.locator(".queue-list li").count(), 0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  await panel
    .getByLabel("Name", { exact: true })
    .fill("Independent queue listener");
  await panel
    .getByLabel("Email", { exact: true })
    .fill(`queue-other-${randomUUID()}@example.com`);
  await panel
    .getByLabel("Password", { exact: true })
    .fill("queue browser test password!");
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await q
    .getByText("No current chapter. Add chapters from a story or playlist.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await q.locator(".queue-list li").count(), 0);
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("soundwave.queue.v1")),
    null,
  );
  pass(
    "another registered account in the same tab starts with no previous owner's current or upcoming entries",
  );
  await nav("/stories/1");
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0.3 &&
      !document.querySelector("audio").paused,
  );
  await nav("/queue");
  const sibling = await context.newPage();
  await sibling.goto(base + "/settings");
  await sibling
    .getByRole("button", { name: "Sign out", exact: true })
    .waitFor();
  const offlineTab = await context.newCDPSession(page);
  await offlineTab.send("Network.enable");
  await offlineTab.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await sibling.getByRole("button", { name: "Sign out", exact: true }).click();
  await q
    .getByText("No current chapter. Add chapters from a story or playlist.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("soundwave.queue.v1")),
    null,
  );
  await offlineTab.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await offlineTab.detach();
  await sibling.close();
  pass(
    "cross-tab logout clears an offline listening tab without page-hide rewriting the retired owner's queue",
  );
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const n of await caches.keys())
      for (const r of await (await caches.open(n)).keys())
        if (
          /\/api\/(queue|auth|playlists|library|progress|settings|profile|analytics)(\/|$)/.test(
            new URL(r.url).pathname,
          )
        )
          paths.push(r.url);
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
    "logout clears tab queue; no private service-worker cache entries, mobile overflow or uncaught browser errors",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} queue browser checks passed (${kind}).`,
  );
} catch (e) {
  await captureBrowserFailure(page, "queue");
  throw e;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
