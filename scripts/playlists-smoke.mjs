// Real UI/API integration. Uses a temporary SQLite database or generated PG schema.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";

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
let browser;
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/library");
  const section = page.getByRole("region", { name: "Private playlists" });
  await section.getByText("No playlists yet", { exact: true }).waitFor();
  const guest = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(guest.user.kind, "guest");
  await section
    .getByLabel("Playlist name", { exact: true })
    .fill("Evening escapes");
  await section
    .getByRole("button", { name: "Create playlist", exact: true })
    .click();
  await section
    .getByRole("heading", { name: "Evening escapes", exact: true })
    .waitFor();
  const id = new URL(page.url()).searchParams.get("playlist");
  assert.ok(id);
  pass("an isolated guest creates a private named playlist from My Library");
  async function add(story, count) {
    await section
      .getByLabel("Story to add", { exact: true })
      .selectOption(String(story));
    await section
      .getByRole("button", { name: "Add story to playlist", exact: true })
      .click();
    await section
      .getByText(`${count} / 100 stories · Added in order`, { exact: true })
      .waitFor();
    await section
      .getByRole("button", { name: "Save playlist name", exact: true })
      .waitFor({ state: "visible" });
  }
  await add(3, 1);
  await add(1, 2);
  assert.deepEqual(
    await section.locator(".playlist-story .story-title").allTextContents(),
    ["Letters to June", "The Midnight Frequency"],
  );
  await section.getByLabel("Rename playlist", { exact: true }).fill(" ");
  await section
    .getByRole("button", { name: "Save playlist name", exact: true })
    .click();
  await section.getByRole("alert").filter({ hasText: "1–80" }).waitFor();
  await section
    .getByLabel("Rename playlist", { exact: true })
    .fill("Night drives");
  await section
    .getByRole("button", { name: "Save playlist name", exact: true })
    .click();
  await section
    .getByRole("heading", { name: "Night drives", exact: true })
    .waitFor();
  pass(
    "add stories in insertion order, reject an invalid rename and recover with a valid name",
  );
  await section
    .getByRole("button", {
      name: "Remove Letters to June from playlist",
      exact: true,
    })
    .click();
  await section
    .getByText("1 / 100 stories · Added in order", { exact: true })
    .waitFor();
  await add(3, 2);
  assert.deepEqual(
    await section.locator(".playlist-story .story-title").allTextContents(),
    ["The Midnight Frequency", "Letters to June"],
  );
  pass(
    "removing and re-adding a story places it last without changing favorites",
  );
  await section
    .getByRole("button", { name: "Play The Midnight Frequency", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await section
    .getByRole("button", {
      name: "Add The Midnight Frequency to your library",
      exact: true,
    })
    .click();
  await section
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .waitFor();
  await page.reload();
  await section
    .getByRole("heading", { name: "Night drives", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0.5 &&
      document.querySelector("audio")?.paused,
  );
  assert.equal(new URL(page.url()).searchParams.get("playlist"), id);
  pass(
    "selected playlist survives refresh and uses the real player, favorite and paused-progress persistence",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const email = `playlist-${randomUUID()}@example.com`,
    password = "playlist browser test password!",
    panel = page.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Name", { exact: true }).fill("Playlist listener");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await section
    .getByRole("heading", { name: "Night drives", exact: true })
    .waitFor();
  const registered = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(registered.user.id, guest.user.id);
  assert.equal(
    (
      await page.evaluate(
        (id) => fetch(`/api/playlists/${id}`).then((r) => r.json()),
        id,
      )
    ).stories.length,
    2,
  );
  pass(
    "guest-to-registered account upgrade retains the playlist and all membership",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in or start a demo session to manage private playlists/)
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Night drives", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      (id) => fetch(`/api/playlists/${id}`).then((r) => r.status),
      id,
    ),
    401,
  );
  const otherContext = await browser.newContext(),
    other = await otherContext.newPage();
  await other.goto(base + `/library?playlist=${id}`);
  await other
    .getByRole("region", { name: "Private playlists" })
    .getByText("Playlist not found.", { exact: true })
    .waitFor();
  assert.equal(
    await other.evaluate(
      (id) => fetch(`/api/playlists/${id}`).then((r) => r.status),
      id,
    ),
    404,
  );
  assert.deepEqual(
    (await other.evaluate(() => fetch("/api/playlists").then((r) => r.json())))
      .playlists,
    [],
  );
  pass(
    "logout clears private UI and an independent guest cannot read another listener's playlist",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await section
    .getByRole("heading", { name: "Night drives", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    const s = await fetch("/api/auth/session").then((r) => r.json());
    for (let i = 0; i < 21; i++) {
      const r = await fetch("/api/playlists", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": s.csrfToken,
        },
        body: JSON.stringify({ name: `Pagination fixture ${i}` }),
      });
      if (r.status !== 201) throw Error("Pagination fixture creation failed");
    }
  });
  await section
    .getByRole("button", { name: "All playlists", exact: true })
    .click();
  await page.reload();
  await section.locator(".playlist-card").first().waitFor();
  assert.equal(await section.locator(".playlist-card").count(), 20);
  await section
    .getByRole("button", { name: "Load more playlists", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".playlist-card").length === 22,
  );
  pass(
    "returning account restores collections and bounded 20-item pages load the remaining playlists",
  );
  // A controlled fetch fixture also works when the service worker owns network
  // fetches (page.route does not intercept those requests).
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, ...args) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      if (
        sessionStorage.getItem("playlistSmokeFailReads") === "1" &&
        path === "/api/playlists"
      )
        return Promise.resolve(
          Response.json(
            { error: { message: "Temporary playlist read failure" } },
            { status: 503 },
          ),
        );
      return original(input, ...args);
    };
  });
  await page.evaluate(() =>
    sessionStorage.setItem("playlistSmokeFailReads", "1"),
  );
  await page.reload();
  await section
    .getByText("Temporary playlist read failure", { exact: true })
    .waitFor();
  await page.evaluate(() =>
    sessionStorage.removeItem("playlistSmokeFailReads"),
  );
  await section.getByRole("button", { name: /Try again/ }).click();
  await section.locator(".playlist-card").first().waitFor();
  pass(
    "a failed list request displays a recoverable error and retries successfully",
  );
  await page.goto(base + "/stories/1");
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
  await page.goto(base + `/library?playlist=${id}`);
  await section
    .getByRole("button", { name: "Delete playlist", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Cancel deletion", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      (id) => fetch(`/api/playlists/${id}`).then((r) => r.status),
      id,
    ),
    200,
  );
  await section
    .getByRole("button", { name: "Delete playlist", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Confirm delete playlist", exact: true })
    .click();
  await section.getByText("Playlist deleted.", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      (id) => fetch(`/api/playlists/${id}`).then((r) => r.status),
      id,
    ),
    404,
  );
  const retained = await page.evaluate(async () => ({
    favorites: (await fetch("/api/library").then((r) => r.json())).stories
      .length,
    downloaded: !!(await (
      await caches.open("soundwave-audio-v1")
    ).match("/api/chapters/101/stream")),
  }));
  assert.equal(retained.favorites, 1);
  assert.equal(retained.downloaded, true);
  pass(
    "confirmed deletion removes only the playlist; favorites and the real downloaded chapter remain",
  );
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        if (
          /\/api\/(playlists|auth|library|progress|analytics)(\/|$)/.test(
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
    "private playlists never enter service-worker caches; mobile layout and browser exception checks pass",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} playlist browser checks passed (${kind}).`,
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
