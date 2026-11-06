// Runs the actual combined API/worker entrypoint against disposable services.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { mediaQueue } from "../server/media/queue.js";

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (
  !url ||
  !redisUrl ||
  ![url, redisUrl].every((u) =>
    ["localhost", "127.0.0.1"].includes(new URL(u).hostname),
  )
)
  throw Error("Set disposable local TEST_DATABASE_URL and TEST_REDIS_URL");
const database = "demo_smoke_" + randomUUID().replaceAll("-", "");
const admin = new pg.Pool({ connectionString: url });
const testUrl = new URL(url);
testUrl.pathname = "/" + database;
const dir = await mkdtemp(join(tmpdir(), "soundwave-demo-"));
const healthFile = join(dir, "worker.json");
const prefix = "demo-" + randomUUID();
const queue = mediaQueue({ redisUrl, redisPrefix: prefix });
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const children = [];
let created = false;
async function until(fn) {
  for (let n = 0; n < 300; n++) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(100);
  }
  throw Error("Demo process verification timed out");
}
function start(extra = {}) {
  const child = spawn(process.execPath, ["server/scripts/demo.js"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      APP_ORIGIN: origin,
      DATABASE_URL: testUrl.href,
      DATABASE_DRIVER: "postgres",
      PGSSL: "false",
      REDIS_URL: redisUrl,
      REDIS_PREFIX: prefix,
      CATALOG_CACHE: "true",
      MEDIA_JOBS: "true",
      EMAIL_MODE: "disabled",
      PORT: String(port),
      WORKER_HEALTH_FILE: healthFile,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (v) => {
      child.log = (child.log + v).slice(-10000);
    });
  children.push(child);
  return child;
}
async function request(path, { cookie, csrf, method = "GET", body } = {}) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { Origin: origin, "X-CSRF-Token": csrf } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  return r;
}
try {
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const first = start();
  await until(async () => (await request("/ready")).ok);
  assert.equal((await (await request("/health")).json()).database, "postgres");
  await until(async () => {
    const r = await request("/chapters/101/metadata");
    return r.status === 200;
  });
  const metadata = await (await request("/chapters/101/metadata")).json();
  const initial = await request("/auth/session");
  const initialCookie = initial.headers.get("set-cookie").split(";")[0];
  const initialCsrf = (await initial.json()).csrfToken;
  const demo = await request("/auth/demo", {
    cookie: initialCookie,
    csrf: initialCsrf,
    method: "POST",
    body: {},
  });
  assert.equal(demo.status, 200);
  const cookie = demo.headers.get("set-cookie").split(";")[0];
  const csrf = (await demo.json()).csrfToken;
  assert.equal(
    (await request("/library/1", { cookie, csrf, method: "PUT", body: {} }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(origin + "/api/chapters/101/stream", {
        headers: { Range: "bytes=0-99" },
      })
    ).status,
    206,
  );
  console.log(
    "PASS 1: combined entrypoint migrates PostgreSQL, starts Redis media processing, authenticates a guest, saves favorites and streams ranges",
  );

  const state = JSON.parse(await readFile(healthFile, "utf8"));
  assert.equal(state.mediaReady, true);
  const stopped = once(first, "exit");
  process.kill(state.pid, "SIGKILL");
  const [code] = await stopped;
  assert.equal(code, 1);
  await assert.rejects(
    fetch(origin + "/api/ready", { signal: AbortSignal.timeout(1000) }),
  );
  console.log(
    "PASS 2: a real worker crash shuts down the API and fails the supervisor instead of hiding missing jobs",
  );

  const second = start();
  await until(async () => (await request("/ready")).ok);
  const library = await (await request("/library", { cookie })).json();
  assert.equal(library.stories[0].id, 1);
  assert.deepEqual(
    await (await request("/chapters/101/metadata")).json(),
    metadata,
  );
  console.log(
    "PASS 3: restarted demo retains the PostgreSQL session, favorite and processed audio result",
  );
  const ended = once(second, "exit");
  second.kill("SIGTERM");
  assert.equal((await ended)[0], 0);
  await assert.rejects(readFile(healthFile));
  console.log(
    "PASS 4: termination drains both processes and removes worker health state",
  );

  const invalid = start({ APP_ORIGIN: "invalid-origin" });
  await until(() => invalid.exitCode !== null);
  assert.equal(invalid.exitCode, 1);
  console.log(
    "PASS 5: invalid startup configuration fails the combined service clearly",
  );
} catch (error) {
  for (const child of children) console.error(child.log);
  throw error;
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
  await queue.obliterate({ force: true });
  await queue.close();
  if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
