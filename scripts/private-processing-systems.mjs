// Isolated real Docker API/worker/volatile Redis + newly created private volume.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { wav } from "../server/test/private-wav-fixture.js";
const key = "soundwave-processing-" + randomUUID().slice(0, 8),
  network = key + "-net",
  volume = key + "-volume",
  redis = key + "-redis",
  api = key + "-api",
  worker = key + "-worker",
  workerImage = "soundwave:processing-worker-test",
  apiImage = "soundwave:processing-api-test";
const results = { date: new Date().toISOString(), checks: [] };
const pass = (s) => {
  results.checks.push(s);
  console.log(`PASS ${results.checks.length}: ${s}`);
};
function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}
async function until(fn) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(300);
  }
  throw Error("Docker processing state deadline exceeded");
}
let base,
  cookie = "",
  csrf = "";
async function request(path, method = "GET", body, type = "application/json") {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { Cookie: cookie, "Content-Type": type, "X-CSRF-Token": csrf },
    ...(body
      ? { body: type === "application/json" ? JSON.stringify(body) : body }
      : {}),
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((s) => s.split(";")[0]).join("; ");
  const json = await r.json();
  if (json.csrfToken) csrf = json.csrfToken;
  assert.ok(r.status < 300, JSON.stringify(json));
  return json;
}
try {
  docker(["build", "--quiet", "--target", "worker", "-t", workerImage, "."]);
  docker(["build", "--quiet", "--target", "api", "-t", apiImage, "."]);
  pass("API and FFmpeg worker images build from the current source");
  docker(["network", "create", network]);
  docker(["volume", "create", volume]);
  docker([
    "run",
    "-d",
    "--name",
    redis,
    "--network",
    network,
    "redis:7.4-alpine",
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  const env = [
    "-e",
    "NODE_ENV=development",
    "-e",
    "APP_ORIGIN=http://127.0.0.1:3001",
    "-e",
    "DATABASE_DRIVER=sqlite",
    "-e",
    "DATABASE_PATH=/app/private-media/runtime.sqlite",
    "-e",
    "PRIVATE_MEDIA_ROOT=/app/private-media/objects",
    "-e",
    `REDIS_URL=redis://${redis}:6379`,
    "-e",
    `REDIS_PREFIX=${key}`,
    "-e",
    "LIBRIVOX_CATALOG=false",
    "-e",
    "EMAIL_MODE=disabled",
    "-e",
    "PROCESSING_TIMEOUT_SECONDS=10",
    "-e",
    "DERIVATIVE_MAX_BYTES=262144",
  ];
  docker([
    "run",
    "-d",
    "--name",
    api,
    "--network",
    network,
    "--mount",
    `type=volume,src=${volume},dst=/app/private-media`,
    "-p",
    "127.0.0.1::3001",
    ...env,
    apiImage,
  ]);
  const address = docker(["port", api, "3001/tcp"]);
  assert.ok(address.startsWith("127.0.0.1:"));
  base = "http://" + address;
  await until(async () => (await fetch(base + "/api/ready")).ok);
  await request("/auth/session");
  await request("/auth/register", "POST", {
    email: `${key}@example.com`,
    password: "private docker processing password!",
    displayName: "Docker creator",
  });
  await request("/creator", "POST", { displayName: "Docker creator", bio: "" });
  const s = (
    await request("/creator/stories", "POST", {
      title: "Docker private story",
      description: "",
      genre: "Test",
      language: "en",
      requestId: randomUUID(),
    })
  ).story;
  const c = (
    await request(`/creator/stories/${s.id}/chapters`, "POST", {
      title: "Audio",
      summary: "",
      requestId: randomUUID(),
      expectedStoryRevision: s.revision,
    })
  ).chapter;
  const path = `/creator/stories/${s.id}/chapters/${c.id}/media`;
  async function upload(frames) {
    const data = await request(path),
      b = wav(frames),
      a = (
        await request(path, "POST", {
          requestId: randomUUID(),
          byteSize: b.length,
          expectedChapterRevision: 1,
          expectedHeadRevision: data.headRevision,
        })
      ).asset;
    await request(`${path}/${a.id}/bytes`, "PUT", b, "audio/wav");
    return a;
  }
  let a = await upload(8000);
  assert.equal((await request(path)).processingIntent.status, "pending");
  pass(
    "real API upload persists a private source and pending database intent before any worker exists",
  );
  docker([
    "run",
    "-d",
    "--name",
    worker,
    "--network",
    network,
    "--mount",
    `type=volume,src=${volume},dst=/app/private-media`,
    "--memory",
    "512m",
    "--cpus",
    "1",
    ...env,
    workerImage,
  ]);
  await until(
    async () => (await request(path)).processingIntent?.status === "ready",
  );
  let state = await request(path);
  assert.equal(state.processingIntent.attempts, 1);
  assert.equal(state.derivative.format, "mp3");
  const host = JSON.parse(docker(["inspect", worker]))[0].HostConfig;
  assert.equal(host.Memory, 536870912);
  assert.equal(host.NanoCpus, 1000000000);
  pass(
    "actual resource-limited Docker worker dispatches the outbox through BullMQ and commits a private MP3",
  );
  docker(["kill", "--signal", "KILL", worker]);
  a = await upload(4000);
  assert.equal((await request(path)).processingIntent.status, "pending");
  docker(["restart", redis]);
  await until(async () => (await fetch(base + "/api/ready")).ok);
  docker(["start", worker]);
  await until(
    async () => (await request(path)).processingIntent?.status === "ready",
  );
  state = await request(path);
  assert.equal(state.processingIntent.attempts, 1);
  assert.equal(state.current.id, a.id);
  pass(
    "worker SIGKILL and volatile Redis restart recover SQL-persisted work without duplicate committed processing",
  );
  await until(async () => {
    const s = await request(path);
    return s.usedBytes === wav(4000).length + s.derivative.byteSize;
  });
  const derivative = state.derivative;
  docker(["restart", api]);
  base = "http://" + docker(["port", api, "3001/tcp"]);
  await until(async () => (await fetch(base + "/api/ready")).ok);
  state = await request(path);
  assert.equal(state.derivative.id, derivative.id);
  assert.equal(state.processingIntent.attempts, 1);
  const preview = await fetch(base + `/api${path}/${a.id}/derivative`, {
    headers: { Cookie: cookie, Range: "bytes=0-31" },
  });
  assert.equal(preview.status, 206);
  assert.equal((await preview.arrayBuffer()).byteLength, 32);
  const original = await fetch(base + `/api${path}/${a.id}/preview`, {
    headers: { Cookie: cookie },
  });
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), wav(4000));
  pass(
    "API restart retains original WAV, ready derivative reference and private range bytes on the named volume",
  );
  const publicRead = await fetch(base + `/api/chapters/${c.id}/stream`);
  assert.equal(publicRead.status, 404);
  const anonymous = await fetch(base + `/api${path}/${a.id}/derivative`);
  assert.equal(anonymous.status, 401);
  pass(
    "Docker-processed media stays excluded from public playback and anonymous derivative access",
  );
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + "\n");
} finally {
  for (const name of [worker, api, redis])
    try {
      docker(["rm", "-f", name]);
    } catch {}
  try {
    docker(["volume", "rm", volume]);
  } catch {}
  try {
    docker(["network", "rm", network]);
  } catch {}
}
