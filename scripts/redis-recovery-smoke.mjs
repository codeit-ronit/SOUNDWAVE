import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "../server/test/phase2-helpers.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
const run = promisify(execFile),
  container = process.env.TEST_REDIS_CONTAINER,
  url = process.env.TEST_REDIS_URL;
if (
  !/^soundwave-[a-z0-9-]+$/.test(container || "") ||
  !url ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
)
  throw Error("Set a dedicated local TEST_REDIS_CONTAINER and TEST_REDIS_URL");
const redis = redisInfrastructure(url, { prefix: "recovery-" + randomUUID() }),
  f = await fixture(process.env.TEST_DATABASE_URL ? "postgres" : "sqlite", {
    redis,
    config: { catalogCacheEnabled: true },
  });
let stopped = false;
try {
  await redis.client.connect();
  const a = await f.client();
  await a.auth("demo");
  await a.get("/stories").expect(200);
  await a.get("/stories").expect(200);
  assert.ok(redis.cacheStats().hits > 0);
  await run("docker", ["stop", container]);
  stopped = true;
  const catalog = await a.get("/stories").expect(200);
  assert.equal(catalog.headers["x-ratelimit-mode"], "local-fallback");
  await a.get("/recommendations").expect(200);
  await a.get("/library").expect(503);
  await a.get("/auth/session").expect(503);
  await a.get("/chapters/101/stream").set("Range", "bytes=0-99").expect(206);
  assert.ok(redis.cacheStats().errors > 0);
  console.log(
    "PASS 1: real Redis outage preserves database catalog/discovery reads and audio ranges, with bounded local fallback",
  );
  console.log(
    "PASS 2: authentication and private writes stay protected instead of silently weakening their distributed limits",
  );
  await run("docker", ["start", container]);
  stopped = false;
  for (let n = 0; n < 100 && !redis.ready(); n++) await delay(100);
  assert.ok(redis.ready());
  const restored = await a.get("/stories").expect(200);
  assert.equal(restored.headers["x-ratelimit-mode"], undefined);
  await a.get("/library").expect(200);
  await a.get("/stories").expect(200);
  assert.ok(redis.cacheStats().hits > 1);
  console.log(
    "PASS 3: client reconnects, refills its cache and retains PostgreSQL sessions after Redis recovery",
  );
} finally {
  if (stopped) await run("docker", ["start", container]);
  await redis.close();
  await f.close();
}
