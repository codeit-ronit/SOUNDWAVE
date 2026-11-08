// Real History UI, persistence and privacy checks; disposable fixture only.
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
  await page.goto(base + "/history");
  const section = page.getByRole("region", {
    name: "Listening history",
    exact: true,
  });
  await section.getByRole("heading", { name: "No saved history" }).waitFor();
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
  const guest = (await api("/auth/session")).body;
  assert.equal(guest.user.kind, "guest");
  const write = (id, revision, position, extra = {}) =>
    api(`/progress/${id}`, "PUT", {
      expectedRevision: revision,
      positionSeconds: position,
      clientId: randomUUID(),
      sequence: 1,
      ...extra,
    });
  assert.equal((await write(101, 0, 4)).status, 200);
  const chapters = (await api("/stories/1/chapters")).body.chapters;
  assert.equal(
    (await write(102, 0, chapters[1].duration_seconds, { completed: true }))
      .status,
    200,
  );
  await api("/library/1", "PUT");
  const playlist = (
    await api("/playlists", "POST", { name: "Retained history fixture" })
  ).body.playlist;
  await api(`/playlists/${playlist.id}/stories/1`, "PUT");
  for (let n = 0; n < 24; n++) {
    await f.db
      .prepare(
        "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,1,?,?,'/audio/1-1.wav',35)",
      )
      .run(800000 + n, 100 + n, `History fixture ${n}`);
    await f.db
      .prepare(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,revision,updated_at) VALUES(?,?,5,1,?)",
      )
      .run(guest.user.id, 800000 + n, "2026-01-01T00:00:00.000Z");
  }
  await section
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Resume A voice in the static", exact: true })
    .waitFor();
  assert.equal(await section.locator(".history-list > li").count(), 20);
  await section
    .getByRole("button", { name: "Load more history", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".history-list > li").length === 26,
  );
  await section.getByText(/This is not full data erasure/).waitFor();
  pass(
    "isolated guest history uses bounded 20-item pages and loads 26 unique bookmarks with privacy and completion labels",
  );
  await section
    .getByRole("button", { name: "Resume A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 4.5 &&
      !document.querySelector("audio")?.paused,
  );
  const saved = waitForProgressSave(
    page,
    (p) => p.chapter_id === 101 && p.position_seconds > 4,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await saved;
  await section
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await section
    .getByRole("button", {
      name: "Remove A voice in the static from history",
      exact: true,
    })
    .click();
  await section
    .getByRole("button", { name: "Cancel removal", exact: true })
    .click();
  assert.equal((await api("/progress/101")).body.progress.removed, false);
  await page
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector("audio")?.paused);
  const before = await page
    .locator("audio")
    .evaluate((a) => ({ time: a.currentTime, src: a.currentSrc }));
  const analytics = (await api("/analytics/overview")).body;
  await section
    .getByRole("button", {
      name: "Remove A voice in the static from history",
      exact: true,
    })
    .click();
  await section
    .getByRole("button", { name: "Confirm remove chapter", exact: true })
    .click();
  await section
    .getByText(
      "Saved history entry removed. Analytics and completion markers remain.",
      { exact: true },
    )
    .waitFor();
  await page.waitForFunction((t) => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > t;
  }, before.time);
  assert.equal(
    await page.locator("audio").evaluate((a) => a.currentSrc),
    before.src,
  );
  const removed = (await api("/progress/101")).body.progress;
  assert.equal(removed.removed, true);
  assert.equal(removed.position_seconds, 0);
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  assert.equal((await api("/library")).body.stories.length, 1);
  assert.equal((await api(`/playlists/${playlist.id}`)).body.stories.length, 1);
  assert.equal((await api("/progress/102")).body.progress.completed, true);
  assert.equal(
    (await api("/analytics/overview")).body.completedChapters,
    analytics.completedChapters,
  );
  pass(
    "cancel is harmless; confirmed removal clears only the bookmark and leaves active audio, favorites, playlist and completion intact",
  );
  await page.reload();
  await section.locator(".history-list > li").first().waitFor();
  assert.equal(
    await section
      .getByRole("button", {
        name: "Resume A voice in the static",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal((await write(101, removed.revision - 1, 9)).status, 409);
  assert.equal((await write(101, removed.revision, 9)).status, 409);
  assert.equal(
    (await write(101, removed.revision, 3, { action: "reset" })).status,
    200,
  );
  await section
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Resume A voice in the static", exact: true })
    .waitFor();
  pass(
    "refresh retains removal; stale and ordinary writes cannot resurrect it, while explicit revision-checked replay restores the bookmark",
  );
  // Freeze the current tab's player by leaving its audio paused. A second device
  // then changes history after the rendered bulk guard was obtained.
  await section
    .getByRole("button", { name: "Clear saved history", exact: true })
    .click();
  const current = (await api("/progress/101")).body.progress;
  assert.equal((await write(101, current.revision, 7)).status, 200);
  await section
    .getByRole("button", { name: "Confirm clear history", exact: true })
    .click();
  await section
    .getByText(
      "History changed. Refresh the list before clearing or retrying removal.",
      { exact: true },
    )
    .waitFor();
  assert.ok((await api("/history")).body.entries.length > 0);
  await section.getByRole("button", { name: "Try again", exact: true }).click();
  await section
    .getByRole("button", { name: "Clear saved history", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Confirm clear history", exact: true })
    .click();
  await section.getByRole("heading", { name: "No saved history" }).waitFor();
  assert.equal((await api("/progress")).body.continueListening.length, 0);
  assert.equal((await api("/progress/102")).body.progress.completed, true);
  pass(
    "bulk confirmation detects another device's newer activity; refreshed retry clears all pages and Continue Listening without resetting completion",
  );
  const email = `history-${randomUUID()}@example.com`,
    password = "history smoke password!";
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const account = page.getByRole("region", { name: "Your account" });
  await account.getByLabel("Name", { exact: true }).fill("History listener");
  await account.getByLabel("Email", { exact: true }).fill(email);
  await account.getByLabel("Password", { exact: true }).fill(password);
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal((await api("/auth/session")).body.user.id, guest.user.id);
  assert.equal((await api("/progress/101")).body.progress.removed, true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in or start a demo session to manage saved history/)
    .waitFor();
  assert.equal((await api("/history")).status, 401);
  const other = await browser.newContext(),
    otherPage = await other.newPage();
  await otherPage.goto(base + "/history");
  await otherPage.getByRole("heading", { name: "No saved history" }).waitFor();
  await other.close();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await account.getByLabel("Email", { exact: true }).fill(email);
  await account.getByLabel("Password", { exact: true }).fill(password);
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await section.getByRole("heading", { name: "No saved history" }).waitFor();
  assert.equal((await api("/progress/102")).body.progress.removed, true);
  pass(
    "guest upgrade preserves tombstones; logout clears private UI and another guest sees none; login restores the correct account state",
  );
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, ...args) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      if (
        sessionStorage.getItem("historyFailReads") === "1" &&
        path === "/api/history"
      )
        return Promise.resolve(
          Response.json(
            { error: { message: "Temporary history read failure" } },
            { status: 503 },
          ),
        );
      return original(input, ...args);
    };
  });
  await page.evaluate(() => sessionStorage.setItem("historyFailReads", "1"));
  await page.reload();
  await section
    .getByText("Temporary history read failure", { exact: true })
    .waitFor();
  await page.evaluate(() => sessionStorage.removeItem("historyFailReads"));
  await section.getByRole("button", { name: "Try again", exact: true }).click();
  await section.getByRole("heading", { name: "No saved history" }).waitFor();
  pass(
    "temporary history read failures show a recoverable error and Retry restores the real server state",
  );
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        if (
          /\/api\/(history|progress|auth|playlists)(\/|$)/.test(
            new URL(request.url).pathname,
          )
        )
          paths.push(request.url);
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
    "history and revision data never enter PWA caches; mobile navigation fits and no browser exceptions occur",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} history browser checks passed (${kind}).`,
  );
} catch (error) {
  await captureBrowserFailure(page, "history");
  throw error;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
