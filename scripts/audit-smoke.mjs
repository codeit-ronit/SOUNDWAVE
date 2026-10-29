// Independent audit: real Node process restarts + actual browser playback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { openDatabase } from "../server/db.js";
import { connectDatabase } from "../server/database/index.js";
const folder = mkdtempSync(join(tmpdir(), "soundwave-independent-audit-"));
const databasePath = join(folder, "audit.sqlite");
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
let child,
  browser,
  checks = 0;
let childErrors = "";
let cookies = "",
  csrf = "",
  savedCookies = [];
const pass = (name) => console.log(`PASS ${++checks}: ${name}`);
async function start() {
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      DATABASE_URL: process.env.DATABASE_URL || "",
      NODE_ENV: "development",
      HTTP_LOG: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    childErrors += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Server did not start: " + childErrors)),
      12000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}: ${childErrors}`));
    });
    child.stdout.on("data", (data) => {
      if (data.toString().includes("SoundWave API")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.equal((await fetch(base + "/api/health")).status, 200);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await closed;
  child = null;
}
async function get(path) {
  const response = await fetch(base + path, { headers: { Cookie: cookies } });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  await start();
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browserOptions = {
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  };
  browser = await chromium.launch(browserOptions);
  let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  let progressWrites = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT" && /\/api\/progress\/\d+/.test(r.url()))
      progressWrites++;
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1.1,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.waitForFunction(async () => {
    const d = await fetch("/api/analytics/overview").then((r) => r.json());
    return (
      d.totalListeningSeconds > 0 &&
      d.recentActivity.some((e) => e.event_type === "playback_paused")
    );
  });
  await page
    .getByRole("button", {
      name: "Add The Midnight Frequency to your library",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  pass(
    "real playback/pause and favorites reach a disk-backed production server",
  );
  const writesBefore = progressWrites;
  await page
    .getByRole("slider", { name: "Playback position", exact: true })
    .evaluate((input) => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set;
      for (let i = 0; i < 80; i++) {
        set.call(input, String(i / 10));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  await page.waitForFunction(async () => {
    const d = await fetch("/api/progress").then((r) => r.json());
    return Math.abs((d.progress[0]?.position_seconds ?? 0) - 7.9) < 0.05;
  });
  assert.ok(
    progressWrites - writesBefore <= 2,
    `Slider drag sent ${progressWrites - writesBefore} writes`,
  );
  pass(
    "80 slider changes persist the latest position with at most two writes, without throttling normal playback",
  );
  savedCookies = await page.context().cookies();
  cookies = savedCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  csrf = (
    await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()))
  ).csrfToken;
  const before = await get("/api/analytics/overview");
  const pid = child.pid;
  await stop();
  await start();
  assert.notEqual(child.pid, pid);
  await page.reload();
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && Math.abs(a.currentTime - 7.9) < 0.1 && a.paused;
  });
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  const after = await get("/api/analytics/overview");
  assert.equal(after.totalListeningSeconds, before.totalListeningSeconds);
  assert.equal(after.favoriteStories, 1);
  assert.equal((await get("/api/library")).stories[0].id, 1);
  pass(
    "progress, paused player restoration, favorites and exact analytics totals survive a new Node process",
  );
  const paused = before.recentActivity.find(
    (e) => e.event_type === "playback_paused",
  );
  const replay = await fetch(base + "/api/analytics/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({
      id: paused.event_id,
      type: "playback_paused",
      chapterId: 101,
      listeningSeconds: paused.listening_seconds,
      playbackRate: 1,
    }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(
    (await get("/api/analytics/overview")).totalListeningSeconds,
    before.totalListeningSeconds,
  );
  pass(
    "analytics event retry stays idempotent after server restart; paused seeking adds no listening time",
  );
  await browser.close();
  browser = null;
  await stop();
  await start();
  const chapters = (await get("/api/stories/1/chapters")).chapters;
  const duration = chapters[0].duration_seconds;
  const clientId = randomUUID();
  for (const [sequence, positionSeconds, completed] of [
    [2, duration, true],
    [1, 0, false],
    [2, duration, true],
  ]) {
    const response = await fetch(base + "/api/progress/101", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ clientId, sequence, positionSeconds, completed }),
    });
    assert.equal(response.status, 200);
  }
  const complete = await get("/api/analytics/overview");
  assert.equal(complete.completedChapters, 1);
  assert.equal(complete.totalListeningSeconds, before.totalListeningSeconds);
  assert.equal(
    complete.recentActivity.filter((e) => e.event_type === "chapter_completed")
      .length,
    1,
  );
  await stop();
  await start();
  browser = await chromium.launch(browserOptions);
  page = await browser.newPage();
  await page.context().addCookies(savedCookies);
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector(".now-playing p")?.textContent.includes("Ch. 2"),
  );
  const second = await get("/api/analytics/overview");
  assert.equal(second.completedChapters, 1);
  assert.equal(second.totalListeningSeconds, complete.totalListeningSeconds);
  pass(
    "stale saves cannot undo completion; one completion event and next-chapter restore survive another restart",
  );
  const db = process.env.DATABASE_URL
    ? await connectDatabase()
    : openDatabase(databasePath);
  const payload = '<img src=x onerror="window.auditInjected=true">';
  await db.prepare("UPDATE stories SET title=? WHERE id=1").run(payload);
  await db.close();
  await page.goto(base + "/stories/1");
  await page.getByRole("heading", { name: payload, exact: true }).waitFor();
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.auditInjected), undefined);
  pass(
    "database-supplied HTML is rendered as React text, without creating executable markup",
  );
  assert.deepEqual(errors, []);
  assert.equal(childErrors, "");
  pass(
    "no uncaught browser errors or server stderr errors in the audit scenario",
  );
  console.log(
    `\n${checks} independent restart/security/browser audit checks passed.`,
  );
} finally {
  if (browser) await browser.close();
  await stop();
  rmSync(folder, { recursive: true, force: true });
}
