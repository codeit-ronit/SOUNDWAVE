// Real HTTP requests against two production Express app instances, isolated schema.
// Large catalog entries below are generated fixtures, not real content or users.
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { postgresAdapter } from "../server/database/adapter.js";
import { migrate } from "../server/database/migrate.js";
import { seedCatalog } from "../server/database/seed.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
const url = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL;
if (!url || !redisUrl)
  throw Error("Set disposable TEST_DATABASE_URL and TEST_REDIS_URL");
const count = Number(process.env.BENCH_REQUESTS || 500),
  concurrency = Number(process.env.BENCH_CONCURRENCY || 10);
if (
  !Number.isInteger(count) ||
  count < 100 ||
  count > 10000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 64
)
  throw Error("Invalid benchmark bounds");
const schema = "http_bench_" + randomUUID().replaceAll("-", ""),
  admin = new pg.Pool({ connectionString: url });
await admin.query(`CREATE SCHEMA ${schema}`);
const db = postgresAdapter(url, { schema }),
  prefix = "http-bench-" + randomUUID(),
  cache = redisInfrastructure(redisUrl, { prefix });
const servers = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
try {
  await migrate(db);
  await seedCatalog(db);
  await cache.client.connect();
  // Both instances include auth/validation/JSON middleware. Only the benchmark's
  // factory-injected rate budget is raised; no public header/route can disable it.
  const config = loadConfig({ APP_ORIGIN: "http://127.0.0.1:3001" });
  async function serve(cached) {
    const server = createApp(db, {
      config: { ...config, catalogCacheEnabled: cached },
      redis: cache,
      rateLimit: { max: 1000000 },
    }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/api/stories?q=mystery&sort=title`;
  }
  const direct = await serve(false),
    cached = await serve(true),
    scenarios = [];
  async function measure(endpoint, expected, useCache) {
    cache.resetCacheStats();
    let cursor = 0,
      success = 0;
    const times = [],
      statuses = {},
      start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= count) break;
          const before = performance.now();
          try {
            const response = await fetch(endpoint, {
                signal: AbortSignal.timeout(10000),
              }),
              body = await response.text();
            statuses[response.status] = (statuses[response.status] || 0) + 1;
            if (response.status === 200 && digest(body) === expected) success++;
          } catch {
            statuses.transport = (statuses.transport || 0) + 1;
          }
          times.push(performance.now() - before);
        }
      }),
    );
    const seconds = (performance.now() - start) / 1000;
    times.sort((a, b) => a - b);
    const percentile = (p) =>
      Number(times[Math.ceil(p * times.length) - 1].toFixed(3));
    return {
      requests: count,
      concurrency,
      seconds: Number(seconds.toFixed(3)),
      successfulRequests: success,
      errors: count - success,
      errorRate: (count - success) / count,
      throughputRps: Number((success / seconds).toFixed(2)),
      latencyMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
      statuses,
      cache: useCache ? cache.cacheStats() : null,
    };
  }
  for (const fixtures of [0, 1000]) {
    if (fixtures)
      await db.transaction(async () => {
        await db
          .prepare(
            `INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity)
    SELECT n,'Generated fixture '||n,'Mystery','Benchmark fixture','Synthetic load-test entry','Generated only inside the disposable benchmark schema','#123456','wave',10 FROM generate_series(10000,10999) n`,
          )
          .run();
        await db
          .prepare(
            `INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds)
    SELECT n*10+c,n,c,'Generated chapter','/audio/1-1.wav',35.155 FROM generate_series(10000,10999) n CROSS JOIN generate_series(1,2) c`,
          )
          .run();
        await db
          .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
          .run(randomUUID());
      });
    const expected = digest(await (await fetch(direct)).text());
    cache.resetCacheStats();
    const coldStart = performance.now(),
      cold = await fetch(cached),
      coldBody = await cold.text();
    if (cold.status !== 200 || digest(coldBody) !== expected)
      throw Error("Cold cached response differs");
    const coldMs = performance.now() - coldStart,
      coldCacheStats = cache.cacheStats();
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      // Alternate order to reduce a simple always-second cache/connection bias.
      const order =
        repeat % 2 ? ["cached", "uncached"] : ["uncached", "cached"];
      const result = { repeat: repeat + 1 };
      for (const mode of order)
        result[mode] = await measure(
          mode === "cached" ? cached : direct,
          expected,
          mode === "cached",
        );
      runs.push(result);
    }
    scenarios.push({
      catalogStories: 6 + fixtures,
      syntheticStories: fixtures,
      coldCachedMs: Number(coldMs.toFixed(3)),
      coldCacheStats,
      runs,
    });
  }
  const result = {
    date: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    scope:
      "Local HTTP load test; isolated PostgreSQL schema, shared Redis, six original stories plus explicitly generated fixtures. Not production scale.",
    rateBudget:
      "Raised only in the local benchmark app factory; distributed throttling is tested separately.",
    scenarios,
  };
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (
    scenarios.some((s) =>
      s.runs.some((r) => r.cached.errors || r.uncached.errors),
    )
  )
    process.exitCode = 1;
} finally {
  for (const server of servers) await new Promise((r) => server.close(r));
  await cache.close();
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
