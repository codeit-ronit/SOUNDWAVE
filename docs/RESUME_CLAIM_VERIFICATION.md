# SoundWave resume claim: implementation and verification

**Date:** 6 November 2026. **Inspected baseline HEAD:** `b540369`, clean at inspection start. This report records this task's executed checks. Earlier phase reports remain historical. Verified implementation commit: `3db19bf`.

**Later deployment update:** The free public demo was subsequently deployed and checked; see [PUBLIC_DEPLOYMENT.md](PUBLIC_DEPLOYMENT.md). Statements below about the older public version describe this earlier implementation checkpoint, not the latest rollout. Performance and production-scale qualifications remain unchanged.

**Catalog extension:** [LIBRIVOX_INTEGRATION.md](LIBRIVOX_INTEGRATION.md) records the later real-source import workflow, 133-test checkpoint and verified public catalog release.

Requested claim:

> Designed a scalable backend architecture integrating PostgreSQL, Redis caching, distributed rate limiting, and asynchronous job processing for media workflows and analytics.

## What already existed and what changed

| Area            | Found at baseline                                                                                                          | Implemented/verified now                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL      | Actual adapter, pooled transactions, FKs/indexes and versioned migrations; automatic local SQLite fallback                 | PostgreSQL is now the default startup expectation, with explicit SQLite compatibility. Docker health and database queries verify actual PostgreSQL persistence. An additive `chapter_media` migration preserves existing rows |
| Redis cache     | Neutral catalog/search/genre cache-aside with TTL/revision invalidation; caching defaulted off; no measured HTTP hit ratio | Hit/miss/error/write counters, configurable test TTL, actual expiry/invalidation/privacy tests, enabled Compose configuration and a complete HTTP benchmark                                                                   |
| Rate limits     | Real Redis atomic shared counters, auth/account policies, streaming exemption; all JSON failed during outage               | Real independent-process shared-limit verification retained. Public catalog/discovery reads now fall back to PostgreSQL with a bounded local limit and explicit degraded header; auth/private operations still fail closed    |
| Async analytics | Real PostgreSQL outbox/queue, rollups, cleanup, retries/fencing and SMTP                                                   | Existing jobs preserved and verified with the new worker lifecycle. They remain PostgreSQL-backed; this report does not relabel them Redis jobs                                                                               |
| Media jobs      | None; no BullMQ or audio-processing worker                                                                                 | Actual BullMQ/Redis queue, metadata extraction and waveform generation from the WAV sample bytes, content-based IDs, retries/backoff, stalled recovery, failed visibility and idempotent DB results                           |
| Docker          | API/worker shared image, database/Redis health checks and volumes                                                          | Explicit `api`/`worker` Docker targets, API readiness and worker heartbeat/Redis health, configurable ports and verified one-command startup                                                                                  |
| Performance     | A short sequential repository sample; caching sometimes slower                                                             | Full HTTP/body comparison, concurrency 10, two alternating runs, cold/warm counters, errors/throughput/percentiles and clearly labeled synthetic larger catalog                                                               |

## Simple explanation

PostgreSQL stores accounts, favorites, history, analytics and processed audio information. Redis holds short-lived browsing results and coordinates request limits across API instances. A BullMQ worker reads audio in the background to calculate real duration, format, RMS level and waveform peaks. Visitors can continue streaming while that work runs. The existing analytics worker continues aggregating listening events asynchronously.

## Media implementation

`server/media/audio.js` parses RIFF chunks and streams bounded PCM samples; it does not read an entire file into one audio Buffer. The supported format is little-endian 16-bit PCM WAV, mono/stereo, 8–192 kHz, up to 100 MB per file. This matches the bundled catalog. It is metadata/waveform processing, **not FFmpeg transcoding**, and does not claim support for arbitrary uploaded formats.

Producer and worker resolve chapter IDs through server-owned catalog paths, enforce filename/real-path containment, and hash the bytes. The worker calculates 128 peak bins, RMS and exact frame-derived duration. `chapter_media` stores one versioned SHA-256 result per chapter with an FK. A transaction/conditional upsert preserves the original timestamp on duplicate processing. Source changes receive a different content-based job ID.

BullMQ uses four attempts with exponential backoff, lock renewal/stalled recovery, bounded completed/failed retention and operator-visible failures. Permanent unsupported/missing media fails visibly. `npm run media -- enqueue|list|retry JOB_ID` operates the queue; the worker automatically schedules missing catalog results. `/api/chapters/:id/metadata` returns pending or persisted results. There is no unauthenticated job-submission endpoint or upload redesign.

The original PostgreSQL outbox remains the authoritative analytics/email pipeline. Keeping its committed records avoids a destructive queue migration. The same supervised worker process runs both workloads; this is still a modular monolith. Durable Redis delivery requires its persistent volume/AOF and operational backups; it is not an exactly-once guarantee under catastrophic Redis data loss. Existing media can be regenerated from the catalog, and DB writes are idempotent.

## Actual automated tests

```bash
# Apply migrations to the disposable backup source first:
DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave npm run db:migrate
TEST_REDIS_URL=redis://127.0.0.1:56379 \
TEST_DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave \
TEST_BACKUP_CONTAINER=soundwave-phase1-pg18 npm test
```

**96 backend + 26 frontend = 122 passed, 0 failed, 0 skipped.** These are actual local PostgreSQL/Redis/container-tool runs, not mocked service equivalents. Without the environment variables, the conditional integrations do not execute.

New coverage includes exact known PCM waveform/RMS samples, malformed input, safe file mappings, real bundled chapter analysis and idempotent timestamps on both DB adapters, metadata API responses, actual BullMQ transient retries/exponential timing and failed jobs, explicit PostgreSQL selection, Redis TTL counters, cache isolation/invalidation and public-read outage fallback. Existing auth, owner isolation, progress ordering, analytics, backups and frontend tests still pass. Backup verification now checks **14** app tables, including derived media.

## Browser, failures and process verification

| Executed check                                                              | Result                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                             | PASS; Vite compiled 1,700 modules and generated the offline shell                                                                                                     |
| `node scripts/browser-smoke.mjs`                                            | 14 checks PASS: actual audio, ranges, library, refresh resume, chapter transitions, discovery and analytics                                                           |
| `node scripts/offline-smoke.mjs`                                            | 13 checks PASS: worker/cache, downloaded audio, range seeking, removal, partial/truncated rejection and quota errors                                                  |
| `node scripts/audit-smoke.mjs`                                              | 7 checks PASS: real process restarts, session/progress/favorite/analytics persistence, save ordering and HTML escaping                                                |
| `node scripts/systems-smoke.mjs` with PostgreSQL/Redis                      | 7 checks PASS: real SMTP capture/auth recovery, playback/analytics and independent Node API processes sharing the Redis limit                                         |
| `node scripts/media-restart-smoke.mjs`                                      | 4 checks PASS: kill active worker with SIGKILL, reclaim stalled job in another process, persist one result, replay idempotently and graceful replacement shutdown     |
| `node scripts/redis-recovery-smoke.mjs`                                     | 3 checks PASS: stop dedicated Redis, retain DB catalog/discovery and 206 media; keep auth/private operations protected; reconnect/refill cache and retain PG sessions |
| `node scripts/mail-smoke.mjs http://127.0.0.1:55002 http://127.0.0.1:60025` | 4 checks PASS on the built app/worker: local SMTP, verification, reset navigation and new-password login                                                              |

**52 browser/process scenario assertions passed**, separate from the 122 automated test count. The sleep timer test advances a browser clock. A hard worker crash was real; production lock/stall intervals remain 30 seconds, while the test supplies one-second intervals to finish promptly.

Docker was started with a private env file and alternate ports using the ordinary command, without a special override file:

```bash
docker compose --env-file /private/tmp/soundwave-claim-compose.env -p soundwave-claim up -d --build
```

Actual service checks:

- API, worker, PostgreSQL, Redis and local inbox were healthy.
- `/api/health` returned `database: postgres`.
- `npm run media -- list` inside the worker reported **12 completed, 0 failed, 0 waiting**.
- PostgreSQL contained **12 `chapter_media` rows**.
- Chapter 101 returned 22,050 Hz, mono, 128 waveform bins and measured duration **35.15546485260771 seconds**.

Local review addresses: app **http://127.0.0.1:55002**, captured inbox **http://127.0.0.1:60025**. These are not public resume URLs.

## Reproducible HTTP load measurement

Artifact: [http-load-results.json](http-load-results.json). Script: `scripts/http-load.mjs` / `npm run bench:http`.

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/test_database \
TEST_REDIS_URL=redis://localhost:PORT npm run bench:http -- docs/http-load-results.json
```

The script creates/drops one isolated schema, starts two real Express HTTP servers on loopback, and compares the same `/api/stories?q=mystery&sort=title` response. One instance uses cache-aside and one does not. Every measured response is fully read and hashed against the uncached result; transport, HTTP and data mismatches count as errors. The factory-only rate budget is raised during this load comparison so 429 policy does not confound throughput. Distributed throttling is verified separately with normal limits; there is no public bypass header.

There are two 500-request runs per mode/catalog at **concurrency 10**, with mode order alternated. The larger case adds **1,000 generated fixture stories and 2,000 fixture chapters** in that disposable schema; they are not real users or published content. No artificial database latency is inserted. Both variants include JSON/auth/limiter middleware and the cached path still reads the authoritative PostgreSQL catalog revision.

| Stories | Run | Mode     | p50 ms | p95 ms | p99 ms | Successful req/s | Errors |
| ------- | --- | -------- | ------ | ------ | ------ | ---------------- | ------ |
| 6       | 1   | Uncached | 4.984  | 9.959  | 26.359 | 1639.30          | 0/500  |
| 6       | 1   | Cached   | 4.282  | 6.689  | 18.981 | 2045.85          | 0/500  |
| 6       | 2   | Uncached | 3.958  | 5.994  | 10.852 | 2357.75          | 0/500  |
| 6       | 2   | Cached   | 3.962  | 5.589  | 6.310  | 2396.05          | 0/500  |
| 1006    | 1   | Uncached | 47.504 | 63.716 | 77.350 | 205.49           | 0/500  |
| 1006    | 1   | Cached   | 24.013 | 39.559 | 79.760 | 369.13           | 0/500  |
| 1006    | 2   | Uncached | 45.402 | 57.613 | 61.802 | 219.00           | 0/500  |
| 1006    | 2   | Cached   | 22.991 | 37.022 | 43.483 | 401.60           | 0/500  |

**4,000 measured requests; 0% transport/HTTP/consistency errors.** Each catalog's cold request recorded one miss/write. Every warm cached run recorded **500 hits, 0 misses, 100% hit ratio**. The JSON artifact includes cold timings and counters. This is intentionally a hot-query workload, not a claim of a production-wide hit ratio.

Interpretation: at 1,006 fixture stories, cached p95 and throughput improved in both local repetitions. Small-catalog differences were modest/variable; older repository measurements showed Redis overhead. The test is short, local, read-heavy, unpaginated and excludes TLS/public networking and real traffic diversity. It does not establish sustained capacity, many-user concurrency, production scalability or a universal cache benefit. Other existing local containers were present; this is not a dedicated benchmark host.

## Resume claim assessment

| Claim component                                                                | Support                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PostgreSQL persistence, relational schema and transactions                     | Fully implemented and verified locally                                                           |
| Redis cache-aside for catalog/discovery, TTL/invalidation/consistency          | Fully implemented and verified locally; cache ratios measured                                    |
| Shared rate limits across Express instances                                    | Fully implemented; actual two-process check and Redis concurrency tests                          |
| Asynchronous Redis-backed media workflow                                       | Fully implemented with BullMQ; real waveform/metadata outputs, retry/failed/crash recovery tests |
| Asynchronous analytics                                                         | Fully implemented and verified through the existing PostgreSQL outbox; not mislabeled BullMQ     |
| Architecture designed to allow multiple API/worker instances                   | Supported by shared state, independent process tests, job locking and idempotence                |
| Production-scale capability, real users, public deployment or scale guarantees | **Not supported by this evidence**                                                               |

The requested sentence is defensible as a statement about architectural design and implemented integrations, provided “scalable” is not presented as measured production capacity. A more precise resume line is:

> Built an audio backend with PostgreSQL, Redis cache-aside discovery, shared rate limits, BullMQ media analysis, and asynchronous analytics aggregation; verified worker-crash recovery and HTTP cache consistency.

## Fixes and limitations

Integration checks exposed missing BullMQ's optional Redis transport dependency, a backup fixture that needed the new migration, and a worker-health assumption incompatible with BullMQ 6.7.1. These were repaired, and the real process/container checks were rerun. Health now uses public worker state plus a Redis readiness connection, not an internal client property.

PostgreSQL migrations are additive; SQLite compatibility remains explicit. This adds one derived-data table and updates backup coverage without deleting prior user rows. Media jobs analyze only the existing PCM WAV catalog; there is no upload/transcoding/object-store pipeline. Waveforms live in PostgreSQL, so no ephemeral generated-file volume is required.

During Redis outage, **public reads** deliberately use per-process fallback limits; the global limit cannot be guaranteed while its coordinator is unavailable. Auth/private operations fail closed. Redis AOF and volumes help durability but are not an HA/DR guarantee. Worker health covers heartbeat and Redis connectivity, not a promise about every queued job's completion time.

The public Vercel demo remains the older deployment. Managed PostgreSQL/Redis/SMTP, separate worker hosting, public TLS, database roles, HA/failover, long-duration load, mixed read/write traffic, arbitrary codecs and cross-browser/mobile hardware are not verified. No production-readiness or real-user claim is made.
