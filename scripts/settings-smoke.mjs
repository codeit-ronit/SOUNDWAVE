// Disposable real-browser profile/preferences regression. No deployed services.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
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
const base = `http://127.0.0.1:${server.address().port}`;
const results = { date: new Date().toISOString(), database: kind, checks: [] };
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
  await page.goto(base + "/settings");
  const profile = page.getByRole("region", { name: "Profile settings" }),
    prefs = page.getByRole("region", { name: "Playback preferences" });
  const speed = prefs.getByLabel("Default playback speed", { exact: true });
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "1");
  assert.equal(
    await prefs.getByLabel("Automatically play the next chapter").isChecked(),
    true,
  );
  await profile.getByText("No email — demo session", { exact: true }).waitFor();
  await profile.getByText("Not linked", { exact: true }).waitFor();
  const guest = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  pass("guest gets safe defaults and read-only identity metadata");
  await page.goto(base + "/stories/1");
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.currentTime > 1,
  );
  await page.evaluate(() => {
    window.settingsSmokeAudio = document.querySelector("audio");
  });
  // Client-side navigation preserves the audio element and current playback.
  await page.locator("a[href='/settings']").first().click();
  await speed.waitFor();
  await profile.getByLabel("Display name", { exact: true }).fill(" ");
  await profile
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  await profile.getByRole("alert").waitFor();
  await profile
    .getByLabel("Display name", { exact: true })
    .fill("Settings listener");
  await profile
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  await profile.getByText("Profile saved.", { exact: true }).waitFor();
  await speed.selectOption("1.5");
  await prefs.getByLabel("Automatically play the next chapter").uncheck();
  await prefs.getByLabel("Default volume", { exact: true }).fill("0.4");
  await prefs
    .getByRole("button", { name: "Save playback preferences", exact: true })
    .click();
  await prefs
    .getByText("Playback preferences saved.", { exact: true })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => {
      const a = document.querySelector("audio");
      return {
        same: a === window.settingsSmokeAudio,
        playing: !a.paused,
        speed: a.playbackRate,
        volume: a.volume,
      };
    }),
    { same: true, playing: true, speed: 1.5, volume: 0.4 },
  );
  pass(
    "invalid name recovers; profile and preferences save without replacing or pausing audio",
  );
  const completed = page.waitForResponse(
    async (r) =>
      new URL(r.url()).pathname === "/api/progress/101" &&
      r.request().method() === "PUT" &&
      r.ok() &&
      JSON.parse(r.request().postData()).completed === true,
  );
  await page.evaluate(() => {
    const a = document.querySelector("audio");
    a.currentTime = a.duration - 0.15;
  });
  await completed;
  await page.waitForFunction(() => document.querySelector("audio")?.ended);
  assert.match(await page.locator("audio").getAttribute("src"), /101\/stream/);
  await page
    .locator(".player")
    .getByRole("button", { name: /Next chapter/ })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.src.includes("102/stream") &&
      !document.querySelector("audio").paused,
  );
  pass(
    "disabled autoplay completes the chapter without transitioning; manual next still works",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Your account" }),
    email = `settings-${randomUUID()}@example.com`,
    password = "settings browser test password!";
  await panel.getByLabel("Name", { exact: true }).fill("Registered listener");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "1.5");
  const registered = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.equal(registered.user.id, guest.user.id);
  await profile.getByText(email, { exact: true }).waitFor();
  await page.reload();
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "1.5");
  pass(
    "guest upgrade retains preferences and owner ID; refresh restores account settings",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in or start a demo session to manage your profile/)
    .waitFor();
  async function login(target) {
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    const p = target.getByRole("region", { name: "Your account" });
    await p.getByLabel("Email", { exact: true }).fill(email);
    await p.getByLabel("Password", { exact: true }).fill(password);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await target
      .getByRole("button", { name: "Sign out", exact: true })
      .waitFor();
  }
  await login(page);
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "1.5");
  const secondContext = await browser.newContext(),
    second = await secondContext.newPage();
  await second.goto(base + "/settings");
  await second.getByLabel("Default playback speed", { exact: true }).waitFor();
  assert.equal(
    await second
      .getByLabel("Default playback speed", { exact: true })
      .inputValue(),
    "1",
  );
  await login(second);
  await second.getByLabel("Default playback speed", { exact: true }).waitFor();
  assert.equal(
    await second
      .getByLabel("Default playback speed", { exact: true })
      .inputValue(),
    "1.5",
  );
  await second
    .getByLabel("Default playback speed", { exact: true })
    .selectOption("2");
  await second
    .getByRole("button", { name: "Save playback preferences", exact: true })
    .click();
  await second
    .getByText("Playback preferences saved.", { exact: true })
    .waitFor();
  await prefs
    .getByRole("button", { name: "Reload saved preferences", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#settings-speed")?.value === "2",
  );
  pass(
    "logout/login and a second authenticated browser session restore preferences; explicit reload sees remote changes",
  );
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, ...args) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      return sessionStorage.getItem("settingsSmokeFail") === "1" &&
        path === "/api/settings"
        ? Promise.resolve(
            Response.json(
              { error: { message: "Temporary settings read failure" } },
              { status: 503 },
            ),
          )
        : original(input, ...args);
    };
  });
  await page.evaluate(() => sessionStorage.setItem("settingsSmokeFail", "1"));
  await page.reload();
  await prefs.getByText(/Temporary settings read failure/).waitFor();
  await page.evaluate(() => sessionStorage.removeItem("settingsSmokeFail"));
  await prefs
    .getByRole("button", { name: "Reload preferences", exact: true })
    .click();
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "2");
  pass(
    "failed settings reads expose a recoverable error and retry without losing persisted preferences",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in or start a demo session to manage your profile/)
    .waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const otherEmail = `settings-other-${randomUUID()}@example.com`;
  await panel.getByLabel("Name", { exact: true }).fill("Independent listener");
  await panel.getByLabel("Email", { exact: true }).fill(otherEmail);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "1");
  await profile.getByText(otherEmail, { exact: true }).waitFor();
  assert.equal(
    await prefs.getByLabel("Automatically play the next chapter").isChecked(),
    true,
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in or start a demo session to manage your profile/)
    .waitFor();
  await login(page);
  await speed.waitFor();
  assert.equal(await speed.inputValue(), "2");
  await profile.getByText(email, { exact: true }).waitFor();
  pass(
    "switching accounts in the same browser clears private profile/preferences and restores each owner's values",
  );
  const cached = await page.evaluate(async () => {
    const found = [];
    for (const n of await caches.keys())
      for (const r of await (await caches.open(n)).keys())
        if (/\/api\/(profile|settings)(\/|$)/.test(new URL(r.url).pathname))
          found.push(r.url);
    return found;
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
    "private settings are absent from service-worker caches; mobile layout and browser exception checks pass",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} settings browser checks passed (${kind}).`,
  );
} catch (error) {
  await captureBrowserFailure(page, "settings");
  throw error;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
