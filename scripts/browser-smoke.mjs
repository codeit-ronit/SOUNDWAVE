// Real browser / production-server smoke test. Uses a fresh temporary SQLite DB.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { openDatabase, seedDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
const directory = mkdtempSync(join(tmpdir(), "soundwave-browser-"));
const db = openDatabase(join(directory, "demo.sqlite"));
seedDatabase(db);
const server = createApp(db).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser,
  checks = 0;
const errors = [];
const check = (name) => {
  checks++;
  console.log(`PASS ${checks}: ${name}`);
};
try {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath =
    process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  await page
    .getByRole("heading", { name: "Find your next obsession." })
    .waitFor();
  await page.locator(".story-grid .story-card").first().waitFor();
  assert.equal(await page.locator("#browse .story-card").count(), 6);
  check("production SPA renders the catalog from the API");
  mkdirSync("docs", { recursive: true });
  await page.screenshot({ path: "docs/soundwave-desktop.png", fullPage: true });
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1.2,
    {},
    { timeout: 15000 },
  );
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), false);
  check("actual local chapter audio decodes and playback time advances");
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.waitForFunction(async () => {
    const p = await fetch("/api/progress").then((r) => r.json());
    return p.progress[0]?.position_seconds > 1;
  });
  const saved = await page.evaluate(
    async () =>
      (await fetch("/api/progress").then((r) => r.json())).progress[0]
        .position_seconds,
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1,
  );
  const restored = await page
    .locator("audio")
    .evaluate((a) => ({ time: a.currentTime, paused: a.paused }));
  assert.ok(Math.abs(restored.time - saved) < 0.5);
  assert.equal(restored.paused, true);
  await page
    .getByRole("heading", { name: "Continue listening", exact: true })
    .waitFor();
  check(
    "pause persists to SQLite and refresh restores position without autoplay",
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
    .getByRole("link", { name: /My library/ })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Your saved stories", exact: true })
    .waitFor();
  assert.equal(await page.locator(".story-grid .story-card").count(), 1);
  await page.reload();
  await page
    .locator("main")
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  check("favorite survives navigation and a browser refresh in My Library");
  await page
    .locator(".player")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  const before = await page.locator("audio").evaluate((a) => a.currentTime);
  await page
    .locator(".story-grid")
    .getByRole("link", { name: "The Midnight Frequency", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "The chapters", exact: true })
    .waitFor();
  await page.waitForFunction(
    (t) => document.querySelector("audio")?.currentTime > t + 0.5,
    before,
  );
  check("audio keeps playing while navigating to the story detail page");
  // Move the actual media near its end to exercise browser ended -> save -> next.
  await page.locator("audio").evaluate((a) => {
    a.currentTime = a.duration - 0.4;
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".now-playing p")?.textContent.includes("Ch. 2"),
    {},
    { timeout: 15000 },
  );
  assert.equal(
    db
      .prepare("SELECT completed FROM listening_progress WHERE chapter_id=101")
      .get().completed,
    1,
  );
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 0.5,
  );
  check(
    "completed chapter is persisted and the next chapter plays automatically",
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  const search = page.getByRole("textbox", {
    name: "Search story titles or genres",
  });
  await search.fill("mystery");
  await search.press("Enter");
  await page.getByRole("heading", { name: "Results for “mystery”" }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll("#browse .story-card").length === 2,
  );
  assert.ok(page.url().includes("q=mystery"));
  await page
    .getByRole("combobox", { name: "Sort stories" })
    .selectOption("title");
  await page.waitForFunction(
    () =>
      document.querySelector("#browse .story-title")?.textContent ===
      "The Glass Archive",
  );
  check("backend genre search and title sorting update URL-backed results");
  await search.fill("no such story");
  await search.press("Enter");
  await page.getByRole("heading", { name: "No stories found" }).waitFor();
  check("empty search has an explicit recovery state");
  await page.goto(`${url}/stories/999`);
  await page.getByText("Story not found.", { exact: true }).waitFor();
  check("deep-link routing serves the SPA and shows API errors");
  await page.goto(url);
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("link", { name: /My library/ })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Your library starts with a story" })
    .waitFor();
  check("removing a favorite updates My Library and its empty state");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.locator("#browse .story-card").first().waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: "docs/soundwave-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "My library", exact: true }).click();
  await page
    .getByRole("heading", { name: "My library.", exact: true })
    .waitFor();
  check("mobile layout has no horizontal overflow and navigation works");
  assert.deepEqual(errors, []);
  check("no uncaught browser JavaScript errors during the scenario");
  console.log(
    `\n${checks} browser checks passed. Production URL used for verification: ${url} (temporary local server).`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
