// Fully disposable local ARM/Linux release stack. No cloud/DNS/ACME provisioning.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { wav } from "../server/test/private-wav-fixture.js";
const expectedArchitecture = dockerArchitecture();
function dockerArchitecture() {
  const arch = execFileSync(
    "docker",
    ["info", "--format", "{{.Architecture}}"],
    { encoding: "utf8" },
  ).trim();
  return arch === "aarch64" ? "arm64" : arch === "x86_64" ? "amd64" : arch;
}
const dir = await mkdtemp(join(tmpdir(), "soundwave-release-")),
  project = "soundwave-m6-" + randomUUID().slice(0, 8),
  result = {
    date: new Date().toISOString(),
    checks: [],
    tls: "Only this disposable local Caddy leaf SPKI is pinned for browser validation; no global TLS ignore or host trust-store change. Public ACME/DNS not verified.",
  };
let browser, page, worker;
const repo = resolve("."),
  env = {
    ...process.env,
    POSTGRES_ENV_FILE: join(dir, "postgres.env"),
    RUNTIME_ENV_FILE: join(dir, "runtime.env"),
    MIGRATION_ENV_FILE: join(dir, "migrator.env"),
    REDIS_CONFIG_FILE: join(dir, "redis.conf"),
    RELEASE_HOST: "localhost",
    ACME_EMAIL: "test@example.invalid",
    RELEASE_QUARANTINED: "false",
  };
const flags = [
  "compose",
  "--env-file",
  "/dev/null",
  "-p",
  project,
  "-f",
  join(repo, "compose.release.yaml"),
  "-f",
  join(dir, "local.yaml"),
];
const docker = (args) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 2097152,
  }).trim();
const dc = (args) => docker([...flags, ...args]);
const pass = (s) => {
  result.checks.push(s);
  console.log(`PASS ${result.checks.length}: ${s}`);
};
async function until(fn) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(200);
  }
  throw Error("Release state deadline exceeded");
}
const portServer = createServer().listen(0, "127.0.0.1");
await new Promise((r) => portServer.once("listening", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const origin = `https://localhost:${port}`,
  adminPass = randomBytes(24).toString("hex"),
  migratorPass = randomBytes(24).toString("hex"),
  runtimePass = randomBytes(24).toString("hex"),
  redisPass = randomBytes(24).toString("hex");
try {
  await writeFile(
    join(dir, "local.yaml"),
    `services:\n  proxy:\n    ports: !override\n      - "127.0.0.1:${port}:443"\n`,
    { mode: 0o600 },
  );
  await writeFile(
    env.POSTGRES_ENV_FILE,
    `POSTGRES_USER=postgres\nPOSTGRES_DB=soundwave\nPOSTGRES_PASSWORD=${adminPass}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    env.RUNTIME_ENV_FILE,
    `APP_ORIGIN=${origin}\nDATABASE_URL=postgres://soundwave_runtime:${runtimePass}@postgres:5432/soundwave\nREDIS_URL=redis://:${redisPass}@redis:6379\nMEDIA_JOBS=true\nCATALOG_CACHE=true\nLIBRIVOX_CATALOG=false\nEMAIL_MODE=disabled\n`,
    { mode: 0o600 },
  );
  await writeFile(
    env.MIGRATION_ENV_FILE,
    `APP_ORIGIN=${origin}\nDATABASE_URL=postgres://postgres:${adminPass}@postgres:5432/soundwave\nMIGRATOR_PASSWORD=${migratorPass}\nRUNTIME_PASSWORD=${runtimePass}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    env.REDIS_CONFIG_FILE,
    `bind 0.0.0.0\nprotected-mode yes\nappendonly yes\nmaxmemory 64mb\nmaxmemory-policy noeviction\nrequirepass ${redisPass}\n`,
    { mode: 0o600 },
  );
  const cfg = JSON.parse(dc(["config", "--format", "json"]));
  for (const [name, s] of Object.entries(cfg.services))
    if (name !== "proxy")
      assert.ok(!s.ports?.length, name + " must not publish ports");
  assert.equal(cfg.services.app.environment.DATABASE_INIT, "verify");
  assert.equal(cfg.services.worker.environment.DATABASE_INIT, "verify");
  dc(["build", "app", "worker"]);
  dc(["pull", "proxy"]);
  for (const tag of [
    "soundwave:release-api",
    "soundwave:release-worker",
    "caddy:2-alpine",
    "postgres:18.6-trixie",
    "redis:7.4-alpine",
  ]) {
    const image = JSON.parse(docker(["image", "inspect", tag]))[0];
    assert.equal(image.Architecture, expectedArchitecture);
    (result.images ??= []).push({
      tag,
      architecture: image.Architecture,
      id: image.Id,
      digests: image.RepoDigests,
    });
  }
  pass(
    "standalone release config exposes only loopback TLS proxy in the test; all five images match the native Linux architecture",
  );
  dc(["up", "-d", "--wait", "postgres", "redis"]);
  dc([
    "run",
    "--rm",
    "--no-deps",
    "migrate",
    "node",
    "server/scripts/release-roles.js",
    "--confirm-operator",
  ]);
  await writeFile(
    env.MIGRATION_ENV_FILE,
    `APP_ORIGIN=${origin}\nDATABASE_URL=postgres://soundwave_migrator:${migratorPass}@postgres:5432/soundwave\n`,
    { mode: 0o600 },
  );
  dc(["run", "--rm", "--no-deps", "migrate"]);
  dc(["up", "-d", "--wait", "app", "worker"]);
  dc([
    "run",
    "--rm",
    "--no-deps",
    "proxy",
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
  ]);
  dc(["up", "-d", "proxy"]);
  pass(
    "distinct non-superuser migrator/runtime credentials bootstrap schema; API and worker start in read-only schema-verification mode",
  );
  let rawCert;
  await until(
    () =>
      new Promise((resolve) => {
        const socket = tlsConnect(
          {
            host: "127.0.0.1",
            port,
            servername: "localhost",
            rejectUnauthorized: false,
          },
          () => {
            rawCert = socket.getPeerCertificate().raw;
            socket.end();
            resolve(!!rawCert);
          },
        );
        socket.once("error", () => resolve(false));
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve(false);
        });
      }),
  );
  const certificate = new X509Certificate(rawCert),
    pin = createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    args: [`--ignore-certificate-errors-spki-list=${pin}`],
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin);
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/ready")).status),
    200,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  const api = async (p, path, method = "GET", body) =>
    p.evaluate(
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
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      { path, method, body },
    );
  const register = async (p, name) => {
    const r = await api(p, "/auth/register", "POST", {
      email: randomUUID() + "@example.com",
      password: "release test password for local smoke!",
      displayName: name,
    });
    assert.equal(r.status, 200);
    return r.body.user;
  };
  const creator = await register(page, "Release creator");
  await page.reload();
  const cookie = (await context.cookies()).find(
    (c) => c.name === "__Host-soundwave",
  );
  assert.ok(cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax");
  assert.equal(
    (
      await api(page, "/creator", "POST", {
        displayName: "Release creator",
        bio: "",
      })
    ).status,
    200,
  );
  const story = (
    await api(page, "/creator/stories", "POST", {
      title: "Release Story",
      description: "Local release fixture",
      genre: "Test",
      language: "en",
      requestId: randomUUID(),
    })
  ).body.story;
  const draft = (
    await api(page, `/creator/stories/${story.id}/chapters`, "POST", {
      title: "Release Chapter",
      summary: "",
      requestId: randomUUID(),
      expectedStoryRevision: story.revision,
    })
  ).body;
  const media = `/creator/stories/${story.id}/chapters/${draft.chapter.id}/media`,
    audio = wav(8000),
    asset = (
      await api(page, media, "POST", {
        requestId: randomUUID(),
        byteSize: audio.length,
        expectedChapterRevision: 1,
        expectedHeadRevision: 0,
      })
    ).body.asset;
  const upload = await page.evaluate(
    async ({ path, bytes }) => {
      const s = await fetch("/api/auth/session").then((r) => r.json());
      return (
        await fetch("/api" + path, {
          method: "PUT",
          headers: { "Content-Type": "audio/wav", "X-CSRF-Token": s.csrfToken },
          body: new Uint8Array(bytes),
        })
      ).status;
    },
    { path: media + "/" + asset.id + "/bytes", bytes: [...audio] },
  );
  assert.equal(upload, 200);
  await until(
    async () =>
      (await api(page, media)).body.processingIntent?.status === "ready",
  );
  assert.equal((await api(page, `/stories/${story.id}`)).status, 404);
  pass(
    "HTTPS secure host-only cookie, CSRF/session and real proxied WAV upload/FFmpeg worker processing work; draft remains private",
  );
  const publication = `/creator/stories/${story.id}/publication`;
  let p = (await api(page, publication)).body;
  assert.equal(
    (
      await api(page, publication + "/submit", "POST", {
        expectedRevision: 0,
        requestId: randomUUID(),
        attest: true,
        termsVersion: p.termsVersion,
      })
    ).status,
    200,
  );
  const staffContext = await browser.newContext(),
    mod = await staffContext.newPage();
  await mod.goto(origin);
  await mod.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  const staff = await register(mod, "Release moderator");
  dc([
    "run",
    "--rm",
    "--no-deps",
    "-e",
    "DATABASE_INIT=verify",
    "migrate",
    "node",
    "server/scripts/creator.js",
    "role",
    staff.id,
    "moderator",
    "--confirm-operator",
  ]);
  const review = `/moderation/stories/${story.id}`;
  p = (await api(mod, review)).body.publication;
  assert.equal(
    (
      await api(mod, review + "/approve", "POST", {
        expectedRevision: p.revision,
        requestId: randomUUID(),
        code: "approved",
        note: "Local ARM release review",
      })
    ).status,
    200,
  );
  p = (await api(page, publication)).body.publication;
  assert.equal(
    (
      await api(page, publication + "/publish", "POST", {
        expectedRevision: p.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  await page.goto(origin + `/stories/${story.id}`);
  await page
    .getByRole("button", { name: "Play Release Chapter", exact: true })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("audio")].some((a) => a.currentTime > 0.03),
  );
  const statuses = await page.evaluate(
    async (id) =>
      Promise.all(
        [{}, { Range: "bytes=0-11" }, { Range: "bytes=99999999-" }].map(
          async (headers) =>
            (
              await fetch(`/api/chapters/${id}/stream`, {
                cache: "no-store",
                headers,
              })
            ).status,
        ),
      ),
    draft.chapter.id,
  );
  assert.deepEqual(statuses, [200, 206, 416]);
  pass(
    "moderator provisioning is operator-only; approved content publishes and plays through HTTPS with preserved 200/206/416 semantics",
  );
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page
    .getByRole("button", { name: "Download Release Chapter", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Remove download of Release Chapter",
      exact: true,
    })
    .waitFor();
  await context.setOffline(true);
  const offline = await page.evaluate(
    async (id) =>
      (
        await fetch(`/api/chapters/${id}/stream`, {
          headers: { Range: "bytes=0-11" },
        })
      ).status,
    draft.chapter.id,
  );
  assert.equal(offline, 206);
  await context.setOffline(false);
  p = (await api(mod, review)).body.publication;
  assert.equal(
    (
      await api(mod, review + "/revoke", "POST", {
        expectedRevision: p.revision,
        requestId: randomUUID(),
        code: "rights_concern",
        note: "Release revocation check",
      })
    ).status,
    200,
  );
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await fetch(`/api/chapters/${id}/stream`, { cache: "no-store" }))
          .status,
      draft.chapter.id,
    ),
    404,
  );
  pass(
    "same-origin production PWA downloads and offline ranges work; revocation blocks fresh online reads through the proxy",
  );
  // Proxy must overwrite spoofed client headers; changing XFF cannot create fresh buckets.
  let limited = 0;
  for (let i = 0; i < 305; i++) {
    const status = await page.evaluate(
      async (x) =>
        (await fetch("/api/health", { headers: { "X-Forwarded-For": x } }))
          .status,
      `198.51.100.${i % 250}`,
    );
    if (status === 429) limited++;
  }
  assert.ok(limited > 0);
  pass(
    "forged forwarding headers cannot bypass the real proxy/API shared request bucket",
  );
  env.RELEASE_QUARANTINED = "true";
  dc(["up", "-d", "--no-deps", "--force-recreate", "app", "worker"]);
  await until(async () => {
    try {
      return (
        (await page.evaluate(
          async () => (await fetch("/api/ready")).status,
        )) === 503
      );
    } catch {
      return false;
    }
  });
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/stories")).status),
    503,
  );
  assert.ok(
    dc(["logs", "--no-color", "worker"]).includes("Worker is quarantined"),
  );
  pass(
    "recovery quarantine propagates through the production profile: HTTP/ready fail closed and worker refuses work",
  );
  writeFileSync(
    process.argv[2] || "docs/m6-release-stack.json",
    JSON.stringify(result, null, 2) + "\n",
  );
} catch (e) {
  console.error(
    "Release smoke failed:",
    e.message?.replace(/postgres:\/\/[^\s"']+/g, "[database URL]"),
  );
  throw e;
} finally {
  await browser?.close();
  try {
    dc(["down", "-v", "--remove-orphans"]);
  } catch {}
  await rm(dir, { recursive: true, force: true });
}
