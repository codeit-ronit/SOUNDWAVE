// Verify actual focused controls and native keyboard events, not synthetic window events.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { openDatabase, seedDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
const directory = mkdtempSync(join(tmpdir(), "soundwave-keyboard-"));
const db = openDatabase(join(directory, "demo.sqlite"));
seedDatabase(db);
const server = createApp(db).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = process.argv[2] || `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const page = await browser.newPage();
  await page.goto(base);
  const start = page.getByRole("button", {
    name: "Start listening",
    exact: true,
  });
  await start.click();
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > 0.5;
  });
  assert.equal(await start.evaluate((e) => e === document.activeElement), true);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("audio").paused);
  const before = await page.locator("audio").evaluate((a) => a.currentTime);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (t) => Math.abs(document.querySelector("audio").currentTime - t - 10) < 0.2,
    before,
  );
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    (t) => Math.abs(document.querySelector("audio").currentTime - t) < 0.2,
    before,
  );
  console.log(
    "PASS: Space pauses and arrow keys seek ±10 seconds while Start listening retains focus",
  );
  await page.keyboard.press("Space");
  await page.waitForFunction((t) => {
    const a = document.querySelector("audio");
    return !a.paused && a.currentTime > t + 0.3;
  }, before);
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (t) => document.querySelector("audio").currentTime > t + 10,
    before,
  );
  await page.keyboard.press("Space");
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("audio").paused);
  console.log(
    "PASS: shortcuts also work after clicking the persistent player control",
  );
  const search = page.getByRole("textbox", {
    name: "Search story titles or genres",
  });
  const position = await page.locator("audio").evaluate((a) => a.currentTime);
  await search.fill("hello");
  await search.press("End");
  await search.press("Space");
  await search.press("ArrowLeft");
  assert.equal(await search.inputValue(), "hello ");
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  assert.ok(
    Math.abs(
      (await page.locator("audio").evaluate((a) => a.currentTime)) - position,
    ) < 0.2,
  );
  console.log(
    "PASS: typing spaces and using arrows in search leaves playback untouched",
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
