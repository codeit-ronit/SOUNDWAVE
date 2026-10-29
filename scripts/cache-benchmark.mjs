// A local measurement, not a production throughput claim. Uses a disposable schema.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { postgresAdapter } from "../server/database/adapter.js";
import { migrate } from "../server/database/migrate.js";
import { seedCatalog } from "../server/database/seed.js";
import { catalogRepository } from "../server/repositories/catalog.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
const url = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL;
if (!url || !redisUrl)
  throw Error("Set disposable TEST_DATABASE_URL and TEST_REDIS_URL");
const schema = "benchmark_" + randomUUID().replaceAll("-", ""),
  admin = new pg.Pool({ connectionString: url });
await admin.query(`CREATE SCHEMA ${schema}`);
const db = postgresAdapter(url, { schema }),
  redis = redisInfrastructure(redisUrl, {
    prefix: "benchmark:" + randomUUID(),
  });
try {
  await migrate(db);
  await seedCatalog(db);
  await redis.client.connect();
  const direct = catalogRepository(db),
    cached = catalogRepository(db, redis);
  await cached.stories(null, { q: "mystery" });
  async function measure(repo) {
    const times = [];
    for (let n = 0; n < 100; n++) {
      const start = performance.now();
      await repo.stories(null, { q: "mystery" });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      requests: 100,
      p50Milliseconds: Number(times[49].toFixed(3)),
      p95Milliseconds: Number(times[94].toFixed(3)),
    };
  }
  console.log(
    JSON.stringify(
      {
        catalogStories: 6,
        query: "mystery",
        direct: await measure(direct),
        warmRedis: await measure(cached),
        note: "Sequential local sample. Revision lookup stays in PostgreSQL. No scalability or latency improvement is implied.",
      },
      null,
      2,
    ),
  );
} finally {
  await redis.close();
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
