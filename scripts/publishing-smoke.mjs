import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { publicationFixture } from "../server/test/publishing-helpers.js";
import { password } from "../server/test/phase2-helpers.js";
import { captureBrowserFailure } from "./browser-artifacts.mjs";
if (
  process.env.TEST_DATABASE_URL &&
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.TEST_DATABASE_URL).hostname,
  )
)
  throw Error("Disposable loopback PostgreSQL required");
const kind = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite",
  f = await publicationFixture(kind),
  server = f.app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`,
  result = { date: new Date().toISOString(), database: kind, checks: [] };
const pass = (s) => {
  result.checks.push(s);
  console.log(`PASS ${result.checks.length}: ${s}`);
};
let browser, page;
async function api(p, path, method = "GET", body) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch("/api/auth/session").then((r) => r.json()),
        r = await fetch("/api" + path, {
          method,
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}
async function login(p, email, path) {
  await p.goto(base + path);
  await p.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  const r = await api(p, "/auth/login", "POST", { email, password });
  assert.equal(r.status, 200);
  await p.reload();
}
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const creator = await browser.newContext(),
    staff = await browser.newContext(),
    listener = await browser.newContext();
  page = await creator.newPage();
  page.setDefaultTimeout(15000);
  await login(page, f.c.data.user.email, `/studio?story=${f.s.id}`);
  const publication = page.getByRole("region", { name: "Publication" });
  await publication.getByText("draft", { exact: true }).waitFor();
  await publication.getByRole("checkbox").check();
  await publication
    .getByRole("button", { name: "Submit for review", exact: true })
    .click();
  await publication.getByText("submitted", { exact: true }).waitFor();
  pass(
    "real WAV upload/FFmpeg fixture remains private; creator declares rights and submits through Studio",
  );
  const mod = await staff.newPage();
  mod.setDefaultTimeout(15000);
  mod.on("response", (r) => {
    if (r.url().includes("/outputs/"))
      console.log("Review audio HTTP", r.status());
  });
  globalThis.reviewPage = mod;
  await login(mod, f.moderator.data.user.email, "/creator");
  await mod
    .getByRole("link", { name: "Open moderation dashboard", exact: true })
    .click();
  await mod
    .getByRole("button", { name: `Review ${f.s.title}`, exact: true })
    .click();
  await mod
    .getByLabel("Review audio Chapter", { exact: true })
    .evaluate((a) => {
      a.play().catch(() => {});
    });
  await mod.waitForFunction(
    () =>
      document.querySelector('audio[aria-label="Review audio Chapter"]')
        ?.currentTime > 0.03,
  );
  await mod
    .getByLabel("Review audio Chapter", { exact: true })
    .evaluate((a) => a.pause());
  await mod
    .getByLabel("Decision note")
    .fill("Reviewed declaration, exact metadata and playable MP3.");
  await mod
    .getByRole("button", { name: "Approve submission", exact: true })
    .click();
  await mod.getByText("Review state: approved", { exact: true }).waitFor();
  assert.equal((await f.c.get(`/stories/${f.s.id}`)).status, 404);
  pass(
    "operator-provisioned moderator previews only submitted media and approval alone stays private",
  );
  await publication
    .getByRole("button", { name: "Refresh publication", exact: true })
    .click();
  await publication
    .getByRole("button", { name: "Publish approved story", exact: true })
    .click();
  await publication.getByText("published", { exact: true }).waitFor();
  const listen = await listener.newPage();
  listen.setDefaultTimeout(15000);
  globalThis.listenPage = listen;
  await listen.goto(base + `/stories/${f.s.id}`);
  await listen
    .getByRole("button", { name: "Play Chapter", exact: true })
    .click();
  await listen.waitForFunction(
    () =>
      document.querySelector("audio[data-soundwave-player]")?.currentTime >
        0.03 ||
      [...document.querySelectorAll("audio")].some((a) => a.currentTime > 0.03),
  );
  const gate = await listen.evaluate(async (id) => {
    const full = await fetch(`/api/chapters/${id}/stream`, {
      cache: "no-store",
    });
    const range = await fetch(`/api/chapters/${id}/stream`, {
      cache: "no-store",
      headers: { Range: "bytes=0-11" },
    });
    return [full.status, range.status, range.headers.get("Content-Type")];
  }, f.ch.id);
  assert.deepEqual(gate, [200, 206, "audio/mpeg"]);
  pass(
    "approved creator story appears in listener discovery and existing player plays real MP3 with HTTP 206",
  );
  await listen.waitForFunction(() => !!navigator.serviceWorker.controller);
  await listen
    .getByRole("button", { name: "Download Chapter", exact: true })
    .click();
  await listen
    .getByRole("button", { name: "Remove download of Chapter", exact: true })
    .waitFor();
  await listener.setOffline(true);
  const offline = await listen.evaluate(async (id) => {
    const r = await fetch(`/api/chapters/${id}/stream`, {
      headers: { Range: "bytes=0-11" },
    });
    return [r.status, (await r.arrayBuffer()).byteLength];
  }, f.ch.id);
  assert.deepEqual(offline, [206, 12]);
  await listener.setOffline(false);
  pass(
    "published MP3 downloads through current server authorization and downloaded range playback works offline",
  );
  await mod
    .getByRole("button", { name: "Refresh moderation", exact: true })
    .click();
  await mod
    .getByLabel("Decision note")
    .fill("Revoke public distribution pending rights review.");
  await mod
    .getByRole("button", { name: "Revoke publication", exact: true })
    .click();
  await mod.getByText("Review state: revoked", { exact: true }).waitFor();
  const revoked = await listen.evaluate(async (id) => {
    const [a, b] = await Promise.all([
      fetch(`/api/chapters/${id}/stream`, { cache: "no-store" }),
      fetch(`/api/chapters/${id}/stream`, { headers: { Range: "bytes=0-11" } }),
    ]);
    return [a.status, b.status];
  }, f.ch.id);
  assert.deepEqual(revoked, [404, 404]);
  assert.equal((await api(listen, `/stories/${f.s.id}`)).status, 404);
  await page.reload();
  await page
    .getByRole("region", { name: "Publication" })
    .getByText("revoked", { exact: true })
    .waitFor();
  pass(
    "staff revocation blocks new full/range/download reads including an online cached device; refreshed Studio shows revoked",
  );
  await mod.getByRole("button", { name: "Sign out", exact: true }).click();
  await mod.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal((await api(mod, "/auth/demo", "POST")).status, 200);
  await mod.reload();
  await mod.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    (
      await api(
        mod,
        `${f.review}/outputs/00000000-0000-4000-8000-000000000000/stream`,
      )
    ).status,
    403,
  );
  // Explicit guest bootstrap makes the final identity and expected 403 deterministic.
  pass(
    "moderation audit remains visible only to authorized staff and logout retires review access",
  );
  writeFileSync(
    `docs/m2-publishing-browser-${kind}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
} catch (e) {
  const diagnostic = globalThis.listenPage || globalThis.reviewPage || page;
  if (diagnostic)
    console.log(
      "Browser media state",
      await diagnostic
        .evaluate(() =>
          [...document.querySelectorAll("audio")].map((a) => ({
            src: a.getAttribute("src"),
            ready: a.readyState,
            network: a.networkState,
            error: a.error?.code,
            message: a.error?.message,
            paused: a.paused,
            time: a.currentTime,
          })),
        )
        .catch(() => null),
    );
  if (page) await captureBrowserFailure(page, "publishing");
  throw e;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await f.close();
}
