# Phase 2: Redis, jobs, account recovery and backup verification

**Date:** 29 October 2026. **Baseline:** `c7ad961` (Phase 1). **Implementation checkpoint:** `5239865`, with the subsequent verified router-history and database connection-lifecycle fixes recorded in Git history.

All requested implementation areas are delivered locally. The existing React/Vite/Express app remains in place, with PostgreSQL authoritative and SQLite compatibility retained. This is not a public production launch. The old Vercel portfolio URL has not been redeployed with these capabilities.

## Results by area

| Area                                 | Result                         | Evidence / limits                                                                                                                                                                            |
| ------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distributed throttling               | PASS locally                   | Real Redis atomic counters, expiry and two independent Node API processes sharing one limit; explicit proxy trust; auth-IP/account buckets; no process-local fallback on a configured outage |
| Media during Redis failure           | PASS locally                   | Stopped the Compose Redis service: catalog JSON returned 503, valid audio range returned 206; Redis restart restored readiness                                                               |
| Catalog caching                      | PASS; opt-in                   | Neutral cached public data plus owner-specific database favorite overlays; revision invalidation, bounded 128 slots/revision, 60-second TTL and database fallback on cache failure           |
| Performance measurement              | MEASURED; no speedup           | Six-story sequential local benchmark found Redis slower, so default caching is disabled. Artifact and figures below                                                                          |
| Durable jobs                         | PASS locally                   | Event+outbox transaction atomicity, idempotent enqueue, concurrent claims, stale lease fencing, rollback, retries/backoff, dead letters and graceful worker shutdown                         |
| Analytics and cleanup                | PASS locally                   | Daily owner/genre rebuild includes paused intervals; retries/backfill do not add time twice; bounded expiry/guest cleanup preserves active sessions and registered/legacy users              |
| Verification/recovery                | PASS locally                   | Hashed purpose-bound one-use tokens, expiry/resend invalidation, encrypted delivery jobs, actual local SMTP capture, Chrome forms, all-session revocation and login/reset race regression    |
| Docker stack                         | PASS locally                   | PostgreSQL, Redis, non-root API/worker and Mailpit built and running on isolated loopback ports with volumes; container-served email flows pass                                              |
| Backup/restore                       | PASS locally                   | Shared exported snapshot, 0600 files, exclusive archive creation, SHA-256 verification, 13 app-table fingerprints, generated scratch database restore/drop and tamper rejection              |
| Existing product                     | PASS in Chrome                 | Core player/search/library/analytics scenario, PWA/offline/range/quota checks, process-restart save ordering and keyboard checks                                                             |
| Public deployment and internet email | NOT IMPLEMENTED / NOT VERIFIED | No managed Redis/SMTP/PostgreSQL credentials, public worker host, real sender-domain verification or public rollout was configured                                                           |
| Production security/scalability/DR   | NOT VERIFIED                   | No penetration test, load benchmark, managed failover, scheduled encrypted/offsite backups, recovery promotion or RPO/RTO claim                                                              |

## Automated tests executed

Final full command used disposable local services:

```bash
TEST_REDIS_URL=redis://127.0.0.1:56379 \
TEST_DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave \
TEST_BACKUP_CONTAINER=soundwave-phase1-pg18 npm test
```

**90 backend + 26 frontend tests = 116 passed, 0 failed, 0 skipped.** The final run includes router-history and connection-loss regressions; the production build was rerun.

Conditional Redis/PostgreSQL/backup tests only execute when those variables are supplied. A default `npm test` without the services is not evidence of distributed limits or PostgreSQL restore verification. Database tests use generated schemas/databases; the backup source public schema was migrated first. Test passwords in this report are disposable local fixture values.

New coverage verifies:

- Redis counters are atomic under concurrency, share limits across app instances, expire, and cannot be bypassed with untrusted forwarding headers. /0 proxy trust is rejected.
- Caching never stores a true favorite flag or user ID; the owner overlay stays fresh, seeds invalidate revisions, cardinality is bounded, and disconnected Redis cache reads fall back to the DB.
- A configured limiter outage denies protected JSON while streaming/HEAD continue.
- Event writes and job enqueue roll back together; duplicate events do not create duplicate jobs; rollup/backfill retries do not inflate listening time.
- Concurrent claims differ, expired leases can be reclaimed, stale workers cannot commit effects, failed effects roll back, and exhausted work becomes a dead letter.
- Cleanup respects live guest sessions and preserves registered/legacy identities.
- Recovery tokens are hashed, their delivery payload is authenticated encryption, token purposes cannot be interchanged, and expired/resend/consumed links fail. Concurrent use succeeds once.
- Known/unknown recovery requests use the same accepted body; disabled SMTP reports configuration failure instead of returning a fake token or success.
- Password reset revokes all sessions, including an old-password login racing the reset.
- The frontend accepts a new fragment link on the already-mounted recovery page, removes it from the URL while preserving router state, posts the token, and handles generic/expired feedback.
- A PostgreSQL backend terminated during an asynchronous transaction rolls back its rows and the pool remains usable; socket events do not crash the process.
- A real archive restores into a fresh database with identical public-table fingerprints, refuses an existing output archive, has restrictive permissions, and rejects tampered bytes before restore.

## Browser, process and container checks

| Executed command / check                                                    | Result                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run build`                                                             | PASS; Vite bundle and offline shell generated                                      |
| `node scripts/browser-smoke.mjs`                                            | 14 core playback/library/search/analytics checks passed                            |
| `node scripts/offline-smoke.mjs`                                            | 13 PWA/offline/range/download/quota checks passed                                  |
| `node scripts/audit-smoke.mjs`                                              | 7 actual Node restart/order/analytics/HTML-escaping checks passed                  |
| `node scripts/keyboard-smoke.mjs`                                           | 3 focused player/search-keyboard checks passed                                     |
| `TEST_DATABASE_URL=… TEST_REDIS_URL=… node scripts/systems-smoke.mjs`       | 7 full PostgreSQL/Redis/SMTP/process/Chrome checks passed                          |
| `node scripts/mail-smoke.mjs http://127.0.0.1:54002 http://127.0.0.1:59025` | 4 additional checks passed against the built Compose app/worker/mail catcher       |
| `docker compose … up -d --build`                                            | PASS for all five services; same database/key configuration reaches API and worker |
| Stop/start Compose Redis                                                    | PASS: JSON 503, audio byte range 206, recovered `/api/ready` reported ready        |
| `npm run db:backup -- create …` / `verify …`                                | PASS with container-matched PostgreSQL 18 tools; restored 13 table fingerprints    |
| Formatting, local documentation links, `git diff --check`                   | PASS                                                                               |

That is **48 browser/process scenario checks** (14+13+7+3+7+4), separate from the 116 automated test count. The five-minute sleep test advances a browser clock. No claim depends on screenshots alone.

The full systems script creates a fresh database, starts separate Node API and worker processes, registers through Chrome, waits for real captured SMTP, verifies the email, records actual audio intervals, waits for a background snapshot, restarts the API, resets the password through another delivered email, and signs in again. A second API process then shares the Redis limit; media remains usable after that limit is exceeded. The worker receives SIGTERM and exits cleanly.

Environment: macOS/Node 22.21.1/Google Chrome; Linux ARM64 containers with Node 22.23.4, PostgreSQL 18.6, Redis 7.4 and Mailpit v1.27. Internet mail providers, physical devices, other browsers, other CPU architectures and public TLS behavior are not verified.

## Measured cache tradeoff

[cache-benchmark.json](cache-benchmark.json) records one sequential local sample of 100 identical `mystery` catalog requests per path, over six stories:

| Path                                     | p50      | p95      |
| ---------------------------------------- | -------- | -------- |
| Direct PostgreSQL                        | 0.498 ms | 0.827 ms |
| Warm Redis + authoritative revision read | 0.736 ms | 1.081 ms |

The cache avoided repeating the complex catalog query but still read the DB revision and added a Redis round trip. This sample does **not** support a latency improvement. `CATALOG_CACHE=false` is therefore the default; the feature is available and tested for deliberate evaluation. It is not a load test or evidence of production throughput.

## Failures found and repaired

1. The legacy migration test expected three versions; the additive catalog/jobs/recovery migrations bring SQLite to six. Existing favorite/progress/event preservation assertions still pass.
2. A reset email opened while already on `/account` initially left the old form mounted. Hash navigation is now consumed by the mounted page and covered by unit and full browser checks. Fragment cleanup preserves React Router's history state.
3. Daily background totals must include positive intervals carried by pause events, not just `listening_interval` event types. Rollups rebuild all positive recorded durations; retry/backfill checks assert the exact total.
4. A password-verification operation could otherwise race a reset before session issuance. Login now rechecks the locked user hash; the concurrency regression verifies no old-password session survives reset.
5. Schema-selective dumps explicitly create `public`; a new target already has an empty `public` schema. The restore drill now removes only that empty schema in its generated disposable database before loading. Full restore/fingerprint tests pass; the source is never replaced.
6. A parallel restore test exposed an unhandled socket error during scratch cleanup. Idle connection errors are handled, restore cleanup no longer force-terminates connections, and checked-out transaction/snapshot clients handle disconnects. An actual backend-termination test verifies rollback and pool recovery.
7. SMTP transport limits and TLS validation are applied to transport configuration, and superseded/consumed/expired token jobs are skipped before delivery. Exactly-once network delivery is deliberately not claimed.

## Changed components

- **Redis/config:** `server/infrastructure/redis.js`, `server/config.js`, API middleware, startup/serverless wiring and Compose. Catalog repositories overlay current-owner data instead of caching it.
- **Jobs:** `server/jobs/{queue,worker,handlers,backfill}.js`, transactional event insertion, analytics snapshot endpoint, `worker` and `jobs` scripts.
- **Accounts:** token hashing utility, recovery/mail services, auth routes/session profile, locked login issuance, `AccountRecovery.jsx`, account controls and styles.
- **Operations:** `server/operations/backup.js`, backup CLI, additive PostgreSQL/SQLite migrations and seed/import revision invalidation.
- **Verification:** recovery/jobs/Redis/backup integration tests, frontend recovery regressions, systems/mail smoke scripts and the cache measurement script.
- **Docs:** README, `.env.example`, architecture, [OPERATIONS.md](OPERATIONS.md), this report and the recorded sample. Historical Phase 1/audit reports and screenshots are retained as historical evidence.

## Local deployment used for verification

An isolated Compose project named `soundwave-phase2` uses PostgreSQL port 54032, Redis 56479, app 54002, SMTP 52025 and Mailpit inbox 59025, all on loopback. A private mode-0600 environment file outside the repo supplies a generated database password, SMTP mode/key and app origin. No secret file is committed. Environment variants and sensitive backup extensions are excluded from Git and the Docker build context. The API and worker run the same source/image with a shared PostgreSQL volume; Redis has its own AOF volume.

The runnable local app is **http://127.0.0.1:54002** and its local inbox is **http://127.0.0.1:59025**. These are local development addresses, not public resume URLs. See [Operations](OPERATIONS.md#complete-local-stack) for a portable setup using the default ports rather than verification-only temporary files.

## Remaining limits and recommended next work

- Public rollout requires persistent managed PostgreSQL, authenticated/TLS Redis as appropriate, a supervised worker host, exact HTTPS app origin, a verified SMTP sender/domain and secret management. A Vercel API function alone does not host the durable worker. The old public demo remains unchanged.
- Verification reports email ownership; it is not a mandatory gate for the public listening product. MFA, account deletion, entitlement checks, private downloads and offline mutation synchronization are not implemented.
- SMTP was verified only against local capture. Real inbox delivery, provider quotas, sender-domain DNS and STARTTLS-only transports are not verified. A crash after SMTP acceptance but before DB acknowledgement can duplicate email; stable Message-ID is not an exactly-once guarantee.
- Recovery responses are generic, but no strict timing/anti-enumeration guarantee is made. Duplicate registration remains a conflict; account throttling can affect legitimate users. No penetration test or production security certification was performed.
- Redis catalog caching is optional and showed overhead locally. Its revision lookup is intentional for correctness. Large catalogs, many instances, attacks, backlogs and long network partitions need measurements before changing capacity/thresholds.
- Jobs are delivered at least once with fenced database effects. SMTP occupies a transaction/connection; high-volume delivery may need an external idempotent provider and separate capacity. Dead letters require operator review. Historical backfill is explicit; immediate analytics still use source events.
- The backup is an unencrypted sensitive archive plus integrity manifest. Scheduling, retention/offsite encryption, full source promotion, restricted production roles, cross-major upgrades and disaster recovery targets are not implemented. Trusted archives only; restore SQL is not sandboxed.
- Browser/CPU/mobile and OS-install coverage remains limited to the recorded environment. No scale, production-readiness or real-user claims are supported.
