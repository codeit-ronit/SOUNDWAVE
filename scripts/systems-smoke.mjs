// Full local integration: separate Node API/worker processes, PostgreSQL, Redis,
// actual SMTP capture and real Chrome recovery forms. No external email is sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";
const databaseUrl = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL,
  mailApi = process.env.TEST_MAILPIT_URL || "http://127.0.0.1:58025",
  smtpUrl = process.env.TEST_SMTP_URL || "smtp://127.0.0.1:51025";
if (
  !databaseUrl ||
  !redisUrl ||
  ![databaseUrl, redisUrl, mailApi, smtpUrl].every((value) =>
    ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
  )
)
  throw Error(
    "Provide loopback-only TEST_DATABASE_URL, TEST_REDIS_URL, TEST_MAILPIT_URL and TEST_SMTP_URL",
  );
const admin = new pg.Pool({ connectionString: databaseUrl }),
  name = "systems_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE ${name}`);
const target = new URL(databaseUrl);
target.pathname = "/" + name;
const privateEnv = {
  ...process.env,
  DATABASE_URL: target.toString(),
  NODE_ENV: "development",
  REDIS_URL: redisUrl,
  CATALOG_CACHE: "true",
  REDIS_PREFIX: "systems:" + randomUUID(),
  EMAIL_MODE: "smtp",
  SMTP_URL: smtpUrl,
  EMAIL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  HTTP_LOG: "0",
};
const children = [],
  errors = [];
let browser,
  checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
async function port() {
  const s = createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
}
async function start(file, env, marker) {
  const child = spawn(process.execPath, [file], {
    env: { ...privateEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Child startup timed out")),
      20000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Child exited during startup"));
    });
    child.stdout.on("data", (data) => {
      if (data.toString().includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}
async function emailFor(address, subject) {
  return until(async () => {
    const list = await fetch(mailApi + "/api/v1/messages").then((r) =>
      r.json(),
    );
    const found = list.messages?.find(
      (m) =>
        m.Subject === subject && m.To?.some((to) => to.Address === address),
    );
    if (!found) return null;
    return fetch(mailApi + "/api/v1/message/" + found.ID).then((r) => r.json());
  }, "captured SMTP email");
}
try {
  const p = await port(),
    base = "http://127.0.0.1:" + p;
  let app = await start(
    "server/index.js",
    { PORT: String(p), APP_ORIGIN: base },
    "SoundWave API",
  );
  const worker = await start(
    "server/scripts/worker.js",
    { APP_ORIGIN: base },
    "SoundWave worker",
  );
  await until(async () => {
    try {
      return (await fetch(base + "/api/ready")).status === 200;
    } catch {
      return false;
    }
  }, "API Redis readiness");
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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Your account" }),
    email = "systems-" + randomUUID() + "@example.com",
    password = "systems browser password!";
  await panel.getByLabel("Name", { exact: true }).fill("Systems listener");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const verification = await emailFor(email, "Verify your SoundWave email");
  const verifyLink = verification.Text.match(
    /http:\/\/[^\s]+#verify_email=[a-f0-9]{64}/,
  )?.[0];
  assert.ok(verifyLink);
  pass(
    "registration transaction produces a durable job delivered through real local SMTP",
  );
  await page.goto(verifyLink);
  await page
    .getByRole("button", { name: "Verify email", exact: true })
    .last()
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Email verified." })
    .waitFor();
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(
    (
      await page.evaluate(() =>
        fetch("/api/auth/session").then((r) => r.json()),
      )
    ).user.emailVerified,
    true,
  );
  pass(
    "one-time verification form confirms the address and removes its token from browser history",
  );
  await page.goto(base);
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
  await until(async () => {
    const data = await page.evaluate(() =>
      fetch("/api/analytics/rollups").then((r) => r.json()),
    );
    return data.rollups?.some((row) => row.listening_seconds > 0);
  }, "background analytics rollup");
  pass(
    "real playback remains synchronous while a separate worker materializes owner-scoped analytics",
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
  await stop(app);
  app = await start(
    "server/index.js",
    { PORT: String(p), APP_ORIGIN: base },
    "SoundWave API",
  );
  await page.reload();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: "Remove The Midnight Frequency from your library",
      exact: true,
    })
    .first()
    .waitFor();
  pass(
    "registered session and library survive API process restart with Redis enabled",
  );
  await page.goto(base + "/account");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "If this account exists" })
    .waitFor();
  const reset = await emailFor(email, "Reset your SoundWave password"),
    resetLink = reset.Text.match(
      /http:\/\/[^\s]+#reset_password=[a-f0-9]{64}/,
    )?.[0];
  assert.ok(resetLink);
  await page.goto(resetLink);
  await page
    .getByLabel("New password", { exact: true })
    .fill("replacement systems password!");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Password reset." })
    .waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await page
    .getByRole("link", { name: "Return to sign in", exact: true })
    .click();
  const login = page.getByRole("region", { name: "Your account" });
  await login.getByLabel("Email", { exact: true }).fill(email);
  await login
    .getByLabel("Password", { exact: true })
    .fill("replacement systems password!");
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  pass(
    "SMTP password recovery, reset form and subsequent sign-in work end to end",
  );
  const secondPort = await port(),
    secondBase = "http://127.0.0.1:" + secondPort;
  await start(
    "server/index.js",
    { PORT: String(secondPort), APP_ORIGIN: secondBase },
    "SoundWave API",
  );
  await until(async () => {
    try {
      return (await fetch(secondBase + "/api/ready")).status === 200;
    } catch {
      return false;
    }
  }, "second API readiness");
  let limited = false,
    success = 0;
  for (let n = 0; n < 310; n++) {
    const result = await fetch((n % 2 ? base : secondBase) + "/api/health");
    if (result.status === 429) {
      limited = true;
      break;
    }
    assert.equal(result.status, 200);
    success++;
  }
  assert.ok(limited && success < 300);
  const audio = await fetch(secondBase + "/api/chapters/101/stream", {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(audio.status, 206);
  assert.equal((await audio.arrayBuffer()).byteLength, 100);
  pass(
    "two independent API processes share Redis throttling while range streaming remains available",
  );
  assert.deepEqual(errors, []);
  await stop(worker);
  pass("browser has no uncaught errors and the worker shuts down gracefully");
  console.log(
    `${checks} full PostgreSQL/Redis/SMTP/process/browser checks passed.`,
  );
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
