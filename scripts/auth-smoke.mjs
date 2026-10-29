import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { openDatabase, seedDatabase } from "../server/db.js";
import { connectDatabase } from "../server/database/index.js";
import { createApp } from "../server/app.js";
const folder = mkdtempSync(join(tmpdir(), "soundwave-auth-browser-"));
let db;
if (process.env.DATABASE_URL) db = await connectDatabase();
else {
  db = openDatabase(join(folder, "db.sqlite"));
  seedDatabase(db);
}
const app = createApp(db);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser,
  checks = 0;
const errors = [];
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .waitFor();
  const guest = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(guest.user.kind, "guest");
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
    () => document.querySelector("audio")?.currentTime > 1,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  pass("isolated demo bootstrap preserves favorite and real audio playback");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const email = `browser-${randomUUID()}@example.com`,
    password = "a long browser test password!";
  const panel = page.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Name", { exact: true }).fill("Browser listener");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const account = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(account.user.id, guest.user.id);
  assert.equal(account.user.kind, "registered");
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  pass(
    "registration UI upgrades the guest while retaining library and resume data",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => fetch("/api/library").then((r) => r.status)),
    401,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("region", { name: "Your account" })
    .getByLabel("Email", { exact: true })
    .fill(email);
  await page
    .getByRole("region", { name: "Your account" })
    .getByLabel("Password", { exact: true })
    .fill("wrong password here");
  await page
    .getByRole("region", { name: "Your account" })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Invalid email or password." })
    .waitFor();
  await page
    .getByRole("region", { name: "Your account" })
    .getByLabel("Password", { exact: true })
    .fill(password);
  await page
    .getByRole("region", { name: "Your account" })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  pass(
    "logout revokes access, invalid login is shown, and valid login restores the account",
  );
  const second = await browser.newPage();
  await second.goto(base);
  await second
    .getByRole("button", { name: "Start listening", exact: true })
    .waitFor();
  const other = await second.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.notEqual(other.user.id, account.user.id);
  assert.equal(
    (await second.evaluate(() => fetch("/api/library").then((r) => r.json())))
      .stories.length,
    0,
  );
  pass(
    "a separate browser visitor cannot see the registered listener’s library",
  );
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => fetch("/api/analytics/overview"));
  const leaked = await page.evaluate(async () => {
    const hits = [];
    for (const name of await caches.keys())
      for (const key of await (await caches.open(name)).keys())
        if (
          /\/api\/(auth|library|progress|analytics)/.test(
            new URL(key.url).pathname,
          )
        )
          hits.push(key.url);
    return hits;
  });
  assert.deepEqual(leaked, []);
  assert.deepEqual(errors, []);
  pass(
    "service-worker caches contain no sessions, favorites, progress or analytics",
  );
  console.log(
    `${checks} authentication browser checks passed (${db.dialect || "sqlite"}).`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  rmSync(folder, { recursive: true, force: true });
}
