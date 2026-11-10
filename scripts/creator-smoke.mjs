// Real onboarding/profile UI; generated DB schemas and isolated guest/accounts only.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "../server/test/phase2-helpers.js";
import { provisionIdentity } from "../server/services/creator-operator.js";
import { waitForProgressSave } from "./browser-sync.mjs";
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
  await page.goto(base + "/creator");
  const section = page.getByRole("region", {
    name: "Creator access",
    exact: true,
  });
  await section.getByText(/Demo guests cannot become creators/).waitFor();
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
  assert.equal(
    (
      await api("/creator", "POST", {
        displayName: "No guest escalation",
        bio: "",
      })
    ).status,
    403,
  );
  assert.equal(
    await section
      .getByRole("button", { name: "Activate creator access", exact: true })
      .count(),
    0,
  );
  pass(
    "isolated guests see ineligibility and the server rejects creator activation",
  );
  const email = `creator-${randomUUID()}@example.com`,
    password = "creator browser password!";
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const account = page.getByRole("region", { name: "Your account" });
  await account.getByLabel("Name", { exact: true }).fill("Creator listener");
  await account.getByLabel("Email", { exact: true }).fill(email);
  await account.getByLabel("Password", { exact: true }).fill(password);
  await account
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await section.getByText("Status: not activated", { exact: true }).waitFor();
  assert.equal((await api("/auth/session")).body.user.id, guest.user.id);
  await section
    .getByLabel("Creator display name", { exact: true })
    .fill("Night storyteller");
  await section
    .getByLabel("Creator bio", { exact: true })
    .fill("Private stories, same account.");
  await section
    .getByRole("button", { name: "Activate creator access", exact: true })
    .click();
  await section.getByText("Status: active", { exact: true }).waitFor();
  assert.equal((await api("/creator")).body.platformRole, "listener");
  pass(
    "registration retains the guest UUID; explicit onboarding activates one private creator profile without staff privileges",
  );
  await page.goto(base + "/stories/1");
  await page
    .getByRole("button", { name: "Play A voice in the static", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 1 &&
      !document.querySelector("audio")?.paused,
  );
  const before = await page
    .locator("audio")
    .evaluate((a) => ({ time: a.currentTime, src: a.currentSrc }));
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Creator access", exact: true })
    .click();
  await section.getByText("Status: active", { exact: true }).waitFor();
  const bio = "Edited bio <img src=x onerror=alert(1)>";
  await section.getByLabel("Creator bio", { exact: true }).fill(bio);
  await section
    .getByRole("button", { name: "Save creator profile", exact: true })
    .click();
  await section.getByText("Creator profile saved.", { exact: true }).waitFor();
  await page.waitForFunction((t) => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > t;
  }, before.time);
  assert.equal(
    await page.locator("audio").evaluate((a) => a.currentSrc),
    before.src,
  );
  assert.equal((await api("/creator")).body.creator.bio, bio);
  assert.equal(await section.locator("img").count(), 0);
  pass(
    "profile edits persist while the same real audio element keeps playing; bio markup remains plain text",
  );
  await section
    .getByRole("button", { name: "Deactivate creator access", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Cancel deactivation", exact: true })
    .click();
  assert.equal((await api("/creator")).body.creator.status, "active");
  await section
    .getByRole("button", { name: "Deactivate creator access", exact: true })
    .click();
  await section
    .getByRole("button", { name: "Confirm deactivation", exact: true })
    .click();
  await section.getByText("Status: inactive", { exact: true }).waitFor();
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), false);
  await section
    .getByRole("button", { name: "Reactivate creator access", exact: true })
    .click();
  await section.getByText("Status: active", { exact: true }).waitFor();
  assert.equal(
    await section.getByLabel("Creator bio", { exact: true }).inputValue(),
    bio,
  );
  const saved = waitForProgressSave(
    page,
    (p) => p.chapter_id === 101 && p.position_seconds > 0,
  );
  await page
    .locator(".player")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await saved;
  await page.reload();
  await section.getByText("Status: active", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("audio")?.currentTime > 0.5 &&
      document.querySelector("audio")?.paused,
  );
  assert.equal(
    await section.getByLabel("Creator bio", { exact: true }).inputValue(),
    bio,
  );
  pass(
    "confirmed deactivation/reactivation retain profile and audio; refresh restores the profile and paused listening position",
  );
  await provisionIdentity(f.db, "status", guest.user.id, "suspended");
  await section
    .getByRole("button", { name: "Refresh creator status", exact: true })
    .click();
  await section.getByText("Status: suspended", { exact: true }).waitFor();
  assert.equal(
    await section.getByLabel("Creator bio", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await api("/creator", "POST", { displayName: "Bypass", bio: "" })).status,
    403,
  );
  assert.equal((await api("/creator/deactivate", "POST", {})).status, 403);
  assert.equal(
    (
      await api("/creator", "PUT", {
        displayName: "Bypass",
        bio: "",
        role: "admin",
      })
    ).status,
    400,
  );
  assert.equal((await api("/library/1", "PUT")).status, 200);
  pass(
    "operator suspension is reflected immediately, prevents reactivation and forged role writes, and leaves favorites/listening available",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByText(/Sign in with a registered account to manage creator access/)
    .waitFor();
  assert.equal((await api("/creator")).status, 401);
  const otherContext = await browser.newContext(),
    other = await otherContext.newPage(),
    otherEmail = `creator-other-${randomUUID()}@example.com`;
  await other.goto(base + "/creator");
  await other.getByText(/Demo guests cannot become creators/).waitFor();
  const otherResult = await other.evaluate(
    async ({ email, password }) => {
      let s = await fetch("/api/auth/session").then((r) => r.json());
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": s.csrfToken,
        },
        body: JSON.stringify({
          email,
          password,
          displayName: "Other listener",
        }),
      });
      s = await r.json();
      const c = await fetch("/api/creator", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": s.csrfToken,
        },
        body: JSON.stringify({
          displayName: "Other creator",
          bio: "Different private bio",
        }),
      });
      return c.status;
    },
    { email: otherEmail, password },
  );
  assert.equal(otherResult, 200);
  await otherContext.close();
  async function login(email) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await account.getByLabel("Email", { exact: true }).fill(email);
    await account.getByLabel("Password", { exact: true }).fill(password);
    await account.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  }
  await login(otherEmail);
  await section.getByText("Status: active", { exact: true }).waitFor();
  assert.equal(
    await section.getByLabel("Creator bio", { exact: true }).inputValue(),
    "Different private bio",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText(/Sign in with a registered account/).waitFor();
  await login(email);
  await section.getByText("Status: suspended", { exact: true }).waitFor();
  assert.equal(
    await section.getByLabel("Creator bio", { exact: true }).inputValue(),
    bio,
  );
  pass(
    "logout removes private controls; another guest/account cannot see the previous profile; returning account retains suspension and its own bio",
  );
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, ...args) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        location.href,
      ).pathname;
      if (
        sessionStorage.getItem("creatorFailReads") === "1" &&
        path === "/api/creator"
      )
        return Promise.resolve(
          Response.json(
            { error: { message: "Temporary creator read failure" } },
            { status: 503 },
          ),
        );
      return original(input, ...args);
    };
  });
  await page.evaluate(() => sessionStorage.setItem("creatorFailReads", "1"));
  await page.reload();
  await section
    .getByText("Temporary creator read failure", { exact: true })
    .waitFor();
  await page.evaluate(() => sessionStorage.removeItem("creatorFailReads"));
  await section.getByRole("button", { name: "Try again", exact: true }).click();
  await section.getByText("Status: suspended", { exact: true }).waitFor();
  pass(
    "a failed creator-profile read exposes a recoverable error and retries against real server state",
  );
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const key of await caches.keys())
      for (const req of await (await caches.open(key)).keys())
        if (
          /\/api\/(creator|auth|profile|progress|history)(\/|$)/.test(
            new URL(req.url).pathname,
          )
        )
          paths.push(req.url);
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
    "private creator/session data never enters service-worker caches; mobile layout fits and no uncaught browser errors occur",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
  console.log(
    `${results.checks.length} creator browser checks passed (${kind}).`,
  );
} catch (error) {
  await captureBrowserFailure(page, "creator");
  throw error;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
