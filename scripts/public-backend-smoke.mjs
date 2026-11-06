// Explicitly tests the owned public demo; creates a disposable test account.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
const base = process.argv[2];
if (base !== "https://soundwave-codeit-ronit.vercel.app")
  throw Error(
    "Usage: node scripts/public-backend-smoke.mjs https://soundwave-codeit-ronit.vercel.app",
  );
let browser,
  page,
  checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
const email = `public-smoke-${randomUUID()}@example.com`;
const password = randomUUID() + " public verification!";
const errors = [];
try {
  const health = await fetch(base + "/api/health").then((r) => r.json());
  assert.equal(health.database, "postgres");
  const ready = await fetch(base + "/api/ready").then((r) => r.json());
  assert.equal(ready.redis, "ready");
  pass("resume URL proxies to hosted PostgreSQL and Redis");
  for (const [range, status] of [
    ["bytes=0-99", 206],
    ["bytes=999999999-", 416],
  ]) {
    const r = await fetch(base + "/api/chapters/101/stream", {
      headers: { Range: range },
    });
    assert.equal(r.status, status);
    if (status === 206) assert.equal((await r.arrayBuffer()).byteLength, 100);
  }
  assert.equal(
    (await fetch(base + "/api/chapters/101/stream", { method: "HEAD" })).status,
    200,
  );
  assert.equal(
    (await fetch(base + "/api/stories?q=midnight").then((r) => r.json())).total,
    1,
  );
  const media = await fetch(base + "/api/chapters/101/metadata").then((r) =>
    r.json(),
  );
  assert.equal(media.status, "completed");
  pass(
    "same-origin search, analyzed media, 206/416 ranges and HEAD work through Vercel",
  );
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#browse .story-card").first().waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  const session = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(session.user.kind, "guest");
  const cookie = (await context.cookies()).find(
    (c) => c.name === "__Host-soundwave",
  );
  assert.ok(cookie?.secure && cookie.httpOnly);
  pass(
    "current account UI boots an individual guest with Secure HTTP-only cookies",
  );
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
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1.5,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.waitForFunction(
    async () =>
      (await fetch("/api/progress").then((r) => r.json())).progress[0]
        ?.position_seconds > 1,
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1,
  );
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  assert.equal(
    (await page.evaluate(() => fetch("/api/library").then((r) => r.json())))
      .stories[0].id,
    1,
  );
  pass(
    "real audio decodes; favorite and paused progress survive a public-page refresh",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Your account" });
  await panel
    .getByLabel("Name", { exact: true })
    .fill("Deployment verification");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const account = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(account.user.id, session.user.id);
  assert.equal(account.user.kind, "registered");
  pass("public registration upgrades the guest and retains owned data");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => fetch("/api/library").then((r) => r.status)),
    401,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => fetch("/api/library").then((r) => r.json())))
      .stories[0].id,
    1,
  );
  pass("logout revokes private access and login restores the saved library");
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(base);
  await second.locator("#browse .story-card").first().waitFor();
  const secondSession = await second.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.notEqual(secondSession.user.id, account.user.id);
  assert.equal(
    (await second.evaluate(() => fetch("/api/library").then((r) => r.json())))
      .stories.length,
    0,
  );
  await other.close();
  pass("a separate public visitor cannot see the first listener's library");
  await page.goto(base + "/stories/1");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const download = page.getByRole("button", {
    name: "Download A voice in the static",
    exact: true,
  });
  await download.waitFor();
  await download.click();
  await page
    .getByRole("button", {
      name: "Remove download of A voice in the static",
      exact: true,
    })
    .waitFor();
  await page.goto(base + "/downloads");
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
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > 0.5;
  });
  const range = await page.evaluate(async () => {
    const r = await fetch("/api/chapters/101/stream", {
      headers: { Range: "bytes=5000-5015" },
    });
    return { status: r.status, size: (await r.arrayBuffer()).byteLength };
  });
  assert.deepEqual(range, { status: 206, size: 16 });
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
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await caches.open("soundwave-audio-v1")).keys()).length,
    ),
    0,
  );
  await context.setOffline(false);
  pass(
    "public PWA downloads, reloads and plays offline, serves seek ranges and removes cached audio",
  );
  await page.goto(base);
  const csrf = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(csrf.user.id, account.user.id);
  const withoutCsrf = await page.evaluate(() =>
    fetch("/api/library/1", { method: "DELETE" }).then((r) => r.status),
  );
  assert.equal(withoutCsrf, 403);
  const analytics = await page.evaluate(() =>
    fetch("/api/analytics/overview").then((r) => r.json()),
  );
  assert.ok(analytics);
  assert.deepEqual(errors, []);
  pass(
    "reconnection retains identity, CSRF rejects an unsafe request, analytics responds and no browser exceptions occur",
  );
  console.log(`Public test account for operator cleanup: ${email}`);
  console.log(`${checks} public deployment checks passed.`);
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      "Public check diagnostic:",
      await page
        .evaluate(async () => ({
          path: location.pathname,
          audio: (() => {
            const a = document.querySelector("audio");
            return a
              ? {
                  time: a.currentTime,
                  ready: a.readyState,
                  src: a.currentSrc,
                  error: a.error?.message,
                }
              : null;
          })(),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (e) => e.textContent,
          ),
          progress: await fetch("/api/progress")
            .then((r) => r.json())
            .catch(() => null),
        }))
        .catch(() => null),
    );
  }
  throw error;
} finally {
  await browser?.close();
}
