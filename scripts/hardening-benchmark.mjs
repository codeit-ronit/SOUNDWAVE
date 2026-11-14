import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { publicationFixture } from "../server/test/publishing-helpers.js";
import {
  publicationService,
  RIGHTS_TERMS,
} from "../server/services/publications.js";
import { redisInfrastructure } from "../server/infrastructure/redis.js";
import { createApp } from "../server/app.js";
import { catalogRepository } from "../server/repositories/catalog.js";
const url = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL;
if (
  !url ||
  !redisUrl ||
  ![url, redisUrl].every((u) =>
    ["127.0.0.1", "localhost"].includes(new URL(u).hostname),
  ) ||
  !decodeURIComponent(new URL(url).pathname).startsWith("/soundwave_ci_")
)
  throw Error("Explicit disposable loopback CI PostgreSQL/Redis required");
const stage = process.env.BENCH_STAGE || "current",
  f = await publicationFixture("postgres", {
    frames: 8000 * 480,
    config: {
      derivativeMaxBytes: 8388608,
      processingSeconds: 15,
      uploadSeconds: 10,
    },
  }),
  prefix = "hardening-" + randomUUID(),
  redis = redisInfrastructure(redisUrl, { prefix }),
  servers = [];
const data = {
  stage,
  at: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  workload: {
    fixtureAudioSeconds: 480,
    requestsPerEndpoint: 30,
    concurrency: 4,
    publishCycles: 8,
    delayedStorageMs: 40,
    contentionSynchronization:
      "Contender starts at the actual storage verification hook; lock-wait duration ends at contender COMMIT, not publication completion.",
    limitations:
      "Small loopback fixture catalog, shared 2 CPU/2 GiB Docker VM, warm host filesystem; injected storage delay disclosed separately. Not production capacity.",
  },
  http: [],
  publication: [],
};
const stats = (times, ms, errors = 0) => {
  const a = [...times].sort((a, b) => a - b),
    p = (q) =>
      Number(a[Math.min(a.length - 1, Math.ceil(q * a.length) - 1)].toFixed(3));
  return {
    count: a.length,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    throughputPerSecond: Number((a.length / (ms / 1000)).toFixed(2)),
    errors,
    errorRate: errors / a.length,
  };
};
try {
  await redis.client.connect();
  async function serve(cached) {
    const s = createApp(f.db, {
      config: { ...f.config, catalogCacheEnabled: cached },
      redis,
      rateLimit: { max: 100000 },
    }).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    servers.push(s);
    return `http://127.0.0.1:${s.address().port}`;
  }
  const base = await serve(true),
    uncached = await serve(false),
    headers = {
      Cookie: f.c.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": f.c.data.csrfToken,
    };
  await f.submit();
  await f.approve();
  await f.publish();
  async function measure(
    name,
    path,
    { method = "GET", body, range, cached = true } = {},
  ) {
    let cursor = 0,
      errors = 0;
    const times = [],
      start = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (;;) {
          if (cursor++ >= 30) break;
          const t = performance.now();
          try {
            const r = await fetch((cached ? base : uncached) + "/api" + path, {
              method,
              headers: { ...headers, ...(range ? { Range: range } : {}) },
              ...(body ? { body: JSON.stringify(body) } : {}),
              signal: AbortSignal.timeout(10000),
            });
            await r.arrayBuffer();
            if (!r.ok) errors++;
          } catch {
            errors++;
          }
          times.push(performance.now() - t);
        }
      }),
    );
    data.http.push({
      name,
      ...stats(times, performance.now() - start, errors),
    });
  }
  for (const cached of [false, true]) {
    redis.resetCacheStats();
    await measure(
      "catalog-" + (cached ? "cached" : "uncached"),
      "/stories?q=Test",
      { cached },
    );
    data.http.at(-1).cache = redis.cacheStats();
  }
  for (const [name, path] of [
    ["story", `/stories/${f.s.id}`],
    ["chapters", `/stories/${f.s.id}/chapters`],
    ["progress", "/progress/101"],
    ["playlists", "/playlists?limit=20"],
    ["history", "/history?limit=20"],
    ["stream-200", `/chapters/${f.ch.id}/stream`],
  ])
    await measure(name, path);
  await measure("stream-206", `/chapters/${f.ch.id}/stream`, {
    range: "bytes=0-65535",
  });
  await measure("playlist-create", "/playlists", {
    method: "POST",
    body: { name: "Benchmark playlist" },
  });
  // Progress updates serialize an honest device sequence, preserving CAS semantics.
  let rev = 0;
  const device = randomUUID();
  const progress = [];
  for (let i = 1; i <= 20; i++) {
    const t = performance.now();
    const r = await fetch(base + "/api/progress/101", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        positionSeconds: i,
        expectedRevision: rev,
        clientId: device,
        sequence: i,
      }),
    });
    const b = await r.json();
    if (!r.ok) throw Error("Progress benchmark failed " + JSON.stringify(b));
    rev = b.progress.revision;
    progress.push(performance.now() - t);
  }
  data.http.push({
    name: "progress-write",
    ...stats(
      progress,
      progress.reduce((a, b) => a + b, 0),
    ),
  });
  await measure("history-populated", "/history?limit=20");
  const historyTimes = [];
  for (let i = 0; i < 8; i++) {
    const t = performance.now();
    let r = await fetch(base + "/api/history/101", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expectedRevision: rev }),
    });
    let b = await r.json();
    if (!r.ok) throw Error("History removal benchmark failed");
    rev = b.progress.revision;
    r = await fetch(base + "/api/progress/101", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        positionSeconds: 1,
        expectedRevision: rev,
        clientId: device,
        sequence: 21 + i,
        action: "reset",
      }),
    });
    b = await r.json();
    if (!r.ok) throw Error("History reset benchmark failed");
    rev = b.progress.revision;
    historyTimes.push(performance.now() - t);
  }
  data.http.push({
    name: "history-remove-reset-pair",
    ...stats(
      historyTimes,
      historyTimes.reduce((a, b) => a + b, 0),
    ),
  });
  let operationTimes = {};
  const timed = (service) => ({
    ...service,
    transition: async (principal, id, action, b) => {
      const t = performance.now();
      let conflict = false,
        error = false;
      try {
        return await service.transition(principal, id, action, b);
      } catch (e) {
        conflict = e.status === 409;
        error = !conflict;
        throw e;
      } finally {
        (operationTimes[action] ??= []).push({
          ms: performance.now() - t,
          conflict,
          error,
        });
      }
    },
  });
  const actor = { id: f.c.data.user.id },
    staff = { id: f.moderator.data.user.id },
    svc = timed(publicationService(f.db, f.config)),
    body = (rev, extra = {}) => ({
      expectedRevision: rev,
      requestId: randomUUID(),
      ...extra,
    });
  for (const delayed of [false, true]) {
    let verificationEntered;
    const storage = {
      ...f.service.storage,
      read: async (key) => {
        verificationEntered?.();
        if (delayed) await delay(40);
        return f.service.storage.read(key);
      },
    };
    operationTimes = {};
    const service = timed(publicationService(f.db, f.config, storage)),
      hold = [],
      wait = [],
      actions = [],
      cpu = process.cpuUsage(),
      mem = process.memoryUsage();
    const tx = f.db.transaction;
    const depth = new AsyncLocalStorage();
    f.db.transaction = (fn) =>
      tx(() =>
        depth.getStore()
          ? fn()
          : depth.run(true, async () => {
              const t = performance.now();
              try {
                return await fn();
              } finally {
                hold.push(performance.now() - t);
              }
            }),
      );
    try {
      for (let i = 0; i < 8; i++) {
        let p = (await svc.read(actor, f.s.id)).publication;
        if (p.state === "published")
          await svc.transition(actor, f.s.id, "unpublish", body(p.revision));
        p = (await svc.read(actor, f.s.id)).publication;
        const entered = new Promise((resolve) => {
          verificationEntered = resolve;
        });
        const before = performance.now(),
          pending = service.transition(
            actor,
            f.s.id,
            "submit",
            body(p.revision, { attest: true, termsVersion: RIGHTS_TERMS }),
          );
        // Same-owner competing read begins on an independent pool client, real row lock.
        await entered;
        const t = performance.now();
        const contender = f.db.pool.connect().then(async (c) => {
          try {
            await c.query("BEGIN");
            await c.query(
              "SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",
              [actor.id],
            );
            await c.query("COMMIT");
            wait.push(performance.now() - t);
          } finally {
            c.release();
          }
        });
        await Promise.all([pending, contender]);

        actions.push(performance.now() - before);
        p = (await svc.read(actor, f.s.id)).publication;
        await service.transition(
          staff,
          f.s.id,
          "approve",
          body(p.revision, {
            code: "approved",
            note: "Benchmark fixture review",
          }),
        );
        p = (await svc.read(actor, f.s.id)).publication;
        const results = await Promise.allSettled([
          service.transition(actor, f.s.id, "publish", body(p.revision)),
          svc.transition(
            staff,
            f.s.id,
            "revoke",
            body(p.revision, {
              code: "metadata_issue",
              note: "Benchmark concurrent revocation",
            }),
          ),
        ]);
        const bad = results.filter(
          (r) =>
            r.status === "rejected" &&
            r.reason.permissionCode !== "PUBLICATION_CONFLICT",
        );
        if (bad.length) throw bad[0].reason;
        p = (await svc.read(actor, f.s.id)).publication;
        if (p.state === "published")
          await svc.transition(
            staff,
            f.s.id,
            "revoke",
            body(p.revision, {
              code: "metadata_issue",
              note: "Benchmark final revoke",
            }),
          );
      }
    } finally {
      f.db.transaction = tx;
    }
    data.publication.push({
      operations: Object.fromEntries(
        Object.entries(operationTimes).map(([name, rows]) => [
          name,
          {
            ...stats(
              rows.map((r) => r.ms),
              rows.reduce((n, r) => n + r.ms, 0),
              rows.filter((r) => r.error).length,
            ),
            expectedConflicts: rows.filter((r) => r.conflict).length,
          },
        ]),
      ),
      scenario: delayed ? "injected-40ms-storage" : "local-storage",
      submit: stats(
        actions,
        actions.reduce((a, b) => a + b, 0),
      ),
      transaction: stats(
        hold,
        hold.reduce((a, b) => a + b, 0),
      ),
      competingOwnerLockWait: stats(
        wait,
        wait.reduce((a, b) => a + b, 0),
      ),
      cpu: process.cpuUsage(cpu),
      rssBefore: mem.rss,
      rssAfter: process.memoryUsage().rss,
      pool: {
        total: f.db.pool.totalCount,
        idle: f.db.pool.idleCount,
        waiting: f.db.pool.waitingCount,
      },
    });
  }
  data.worker = {
    processingMs: f.processingMs,
    throughputSourceAudioSecondsPerWallSecond: 480 / (f.processingMs / 1000),
    concurrency: 1,
    workflow:
      "Actual 480-second PCM WAV fixture processed to checked MP3 during fixture setup; full recovery suite separately measures retries/crashes.",
  };
  data.rows = (await catalogRepository(f.db).stories(null)).length;
  writeFileSync(
    process.argv[2] ||
      process.env.BENCH_OUTPUT ||
      `/private/tmp/m34-${stage}.json`,
    JSON.stringify(data, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      stage,
      http: data.http.length,
      publication: data.publication,
    }),
  );
} finally {
  for (const s of servers) await new Promise((r) => s.close(r));
  let cursor = "0";
  do {
    const p = await redis.client.scan(cursor, {
      MATCH: prefix + ":*",
      COUNT: 100,
    });
    cursor = String(p.cursor);
    if (p.keys.length) await redis.client.del(p.keys);
  } while (cursor !== "0");
  await redis.close();
  await f.close();
}
