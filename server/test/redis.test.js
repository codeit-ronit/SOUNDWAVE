import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { setTimeout as delay } from "node:timers/promises";
import { redisInfrastructure } from "../infrastructure/redis.js";
import { createApp } from "../app.js";
import { fixture } from "./phase2-helpers.js";
import { catalogRepository } from "../repositories/catalog.js";
import { seedCatalog } from "../database/seed.js";
import { loadConfig } from "../config.js";
test("configured Redis outage fails closed for JSON but never disables public audio streaming", async () => {
  const redis = {
    consume: async () => {
      throw Error("offline");
    },
    cached: (_r, _k, load) => load(),
    ready: () => false,
  };
  const f = await fixture("sqlite", { redis });
  try {
    await request(f.app).get("/api/stories").expect(503);
    await request(f.app).get("/api/ready").expect(503);
    await request(f.app)
      .get("/api/chapters/101/stream")
      .set("Range", "bytes=0-99")
      .expect(206);
    await request(f.app).head("/api/chapters/101/stream").expect(200);
    assert.equal(
      (await catalogRepository(f.db, redis).stories(null)).length,
      6,
    );
  } finally {
    await f.close();
  }
});
test("proxy trust accepts only explicit IP/CIDR configuration", () => {
  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_CIDRS: "true" }),
    /TRUSTED_PROXY/,
  );
  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_CIDRS: "127.0.0.1/999" }),
    /TRUSTED_PROXY/,
  );
  assert.deepEqual(
    loadConfig({ TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128" }).trustedProxies,
    ["127.0.0.1/32", "::1/128"],
  );
});
if (process.env.TEST_REDIS_URL) {
  async function redisFixture() {
    const prefix = "test:" + randomUUID();
    const redis = redisInfrastructure(process.env.TEST_REDIS_URL, { prefix });
    await redis.client.connect();
    return {
      redis,
      prefix,
      close: async () => {
        let cursor = "0";
        do {
          const page = await redis.client.scan(cursor, {
            MATCH: prefix + ":*",
            COUNT: 100,
          });
          cursor = String(page.cursor);
          if (page.keys.length) await redis.client.del(page.keys);
        } while (cursor !== "0");
        await redis.close();
      },
    };
  }
  test("Redis atomically shares request limits across independent application instances", async () => {
    const r = await redisFixture(),
      f = await fixture("sqlite");
    try {
      const a = createApp(f.db, {
          config: f.config,
          redis: r.redis,
          rateLimit: { max: 2, windowMs: 60000 },
        }),
        b = createApp(f.db, {
          config: f.config,
          redis: r.redis,
          rateLimit: { max: 2, windowMs: 60000 },
        });
      await request(a).get("/api/health").expect(200);
      await request(b).get("/api/health").expect(200);
      const limited = await request(a).get("/api/health").expect(429);
      assert.ok(Number(limited.headers["retry-after"]) > 0);
      await request(b)
        .get("/api/chapters/101/stream")
        .set("Range", "bytes=0-99")
        .expect(206);
    } finally {
      await f.close();
      await r.close();
    }
  });
  test("Redis counter is atomic under concurrency, has expiry, and blocks forged proxy bucket bypasses", async () => {
    const r = await redisFixture(),
      f = await fixture("sqlite");
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          r.redis.consume("atomic", "one", 30000),
        ),
      );
      assert.deepEqual(
        results.map((x) => x.count).sort((a, b) => a - b),
        Array.from({ length: 30 }, (_, i) => i + 1),
      );
      assert.ok(results.every((x) => x.ttlMs > 0 && x.ttlMs <= 30000));
      const app = createApp(f.db, {
        config: f.config,
        redis: r.redis,
        rateLimit: { max: 1 },
      });
      await request(app)
        .get("/api/health")
        .set("X-Forwarded-For", "10.0.0.1")
        .expect(200);
      await request(app)
        .get("/api/health")
        .set("X-Forwarded-For", "10.0.0.2")
        .expect(429);
    } finally {
      await f.close();
      await r.close();
    }
  });
  test("Redis caches only neutral catalog data; favorite overlays remain fresh and isolated", async () => {
    const r = await redisFixture(),
      f = await fixture("sqlite");
    try {
      const repo = catalogRepository(f.db, r.redis),
        original = r.redis.cached.bind(r.redis);
      let loads = 0;
      r.redis.cached = (revision, key, load) =>
        original(revision, key, () => {
          loads++;
          return load();
        });
      const first = await repo.stories(null, { q: "mystery" });
      assert.equal(first.length, 2);
      const second = await repo.stories(null, { q: "mystery" });
      assert.deepEqual(second, first);
      assert.equal(loads, 1);
      await f.db
        .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
        .run("demo-user", 1);
      assert.equal(
        (await repo.stories("demo-user", { q: "mystery" })).find(
          (s) => s.id === 1,
        ).is_favorite,
        true,
      );
      assert.equal(
        (await repo.stories(null, { q: "mystery" })).find((s) => s.id === 1)
          .is_favorite,
        false,
      );
      const keys = await r.redis.client.keys(r.prefix + ":catalog:*");
      for (const key of keys) {
        const value = await r.redis.client.get(key);
        assert.ok(!value.includes("demo-user"));
        assert.ok(!value.includes('"is_favorite":true'));
      }
      await seedCatalog(f.db);
      await repo.stories(null, { q: "mystery" });
      assert.equal(loads, 2);
    } finally {
      await f.close();
      await r.close();
    }
  });
  test("Redis query cache uses bounded slots and serves database results on cache failure", async () => {
    const r = await redisFixture();
    try {
      for (let i = 0; i < 200; i++)
        await r.redis.cached("bounded", "query:" + i, async () => [i]);
      const keys = await r.redis.client.keys(r.prefix + ":catalog:*");
      assert.ok(keys.length <= 128);
      for (const key of keys) assert.ok((await r.redis.client.ttl(key)) > 0);
      await r.redis.close();
      assert.deepEqual(
        await r.redis.cached("offline", "key", async () => ["database"]),
        ["database"],
      );
    } finally {
      if (r.redis.client.isOpen) await r.close();
    }
  });
}

test("universal proxy trust is rejected rather than trusting attacker forwarding headers", () => {
  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }),
    /TRUSTED_PROXY/,
  );
  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_CIDRS: "::/0" }),
    /TRUSTED_PROXY/,
  );
});
