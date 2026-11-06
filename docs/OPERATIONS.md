# SoundWave operations: Redis, jobs, email and recovery drills

These instructions describe the repository's current backend implementation. The [public rollout report](PUBLIC_DEPLOYMENT.md) records the verified free demo deployment and its sleeping/volatile-Redis limits. Internet email delivery, production security certification and measured production scalability are not claimed.

## Complete local stack

Use Node 22.x, Docker and Compose. Copy `.env.example` to `.env` if you do not already have one. Set a strong URL-safe `POSTGRES_PASSWORD`. To enable email delivery, set `EMAIL_MODE=smtp` and a random `EMAIL_ENCRYPTION_KEY` (32 random bytes, encoded as 64 hex characters). Keep `.env` private and out of Git.

For a new local setup, this command appends a generated key without printing it; do not append another key to an existing configured deployment:

```bash
node --input-type=module -e 'import {appendFileSync,chmodSync} from "node:fs"; import {randomBytes} from "node:crypto"; appendFileSync(".env", "\nEMAIL_ENCRYPTION_KEY="+randomBytes(32).toString("hex")+"\n"); chmodSync(".env",0o600);'
docker compose up --build
```

App: **http://localhost:3001**. Local email inbox: **http://localhost:8025**. Mailpit captures messages locally; it does not deliver them to real addresses. Keep its ports on loopback. For Compose, leave `SMTP_URL` unset so the worker uses `smtp://mailpit:1025`. The app and worker need the same key and `APP_ORIGIN`.

Compose runs PostgreSQL, Redis, API, worker and Mailpit. PostgreSQL and Redis have named volumes; Redis uses AOF and `noeviction` with a 64 MB memory cap. `down` preserves volumes; do not run `down -v` when retaining data. The app/worker image runs as non-root. Local HTTP mode uses development cookies; public hosting requires production HTTPS settings and a real verified sender/SMTP service.

For Node/Vite development, start infrastructure with `docker compose up -d postgres redis mailpit`. Set host-accessible `DATABASE_URL`, `REDIS_URL=redis://127.0.0.1:6379`, `SMTP_URL=smtp://127.0.0.1:1025`, and set `APP_ORIGIN` to the actual frontend origin (for example `http://127.0.0.1:5173`). Run `npm run dev` and `npm run worker` in separate terminals. The built one-server frontend instead uses port 3001. Do not mix host-only URLs with container-internal service URLs.

## Redis limits and catalog cache

When `REDIS_URL` is configured, shared atomic counters enforce the general API limit (300/IP/minute), auth-write limit (15/IP/15 minutes), and targeted email/account limit (10/15 minutes). Keys hash bucket identifiers and expire. Media ranges/HEAD remain exempt. Session lookup and revocation stay in PostgreSQL; no session cache weakens logout.

Redis errors/timeouts return **503** for auth/private operations, with Retry-After. Public catalog/discovery reads instead retain PostgreSQL access under a bounded local limiter, marked `X-RateLimit-Mode: local-fallback`. These fallback counters cannot enforce a cluster-wide limit while Redis is unavailable. Existing media delivery stays available. Without `REDIS_URL`, development retains explicitly process-local, bounded limits. The default proxy setting ignores forwarding headers. Set `TRUSTED_PROXY_CIDRS` only for exact real proxy IPs/subnets; universal trust and /0 networks are rejected. Account throttling can also delay legitimate targeted users, so monitor/tune it before public hosting.

`GET /api/ready` checks the database and Redis connection state without consuming the general limit. It is a dependency check, not proof of worker/email health, throughput, or authorization.

Compose and the example enable catalog caching with `CATALOG_CACHE=true`; set it false for comparison or small-catalog evaluation. Results depend on catalog size: the older six-story repository sample showed overhead, while the new [HTTP benchmark](http-load-results.json) records larger generated-fixture benefits. No universal speedup is implied. When enabled:

- Only neutral public story/search/genre results enter Redis. Favorite flags are read from the current owner's database rows on every response. Progress, libraries, sessions and analytics are never shared cache entries.
- Search keys include canonical query/filter/sort data and a catalog revision. Hash-to-slot admission limits each revision to 128 cache keys, each with a 60-second TTL. Hash collisions cause misses/replacement, never another query's response.
- Seeding/import updates the revision in the same transaction as catalog writes. Requests read the authoritative revision from PostgreSQL. Old revision keys expire. Direct manual SQL catalog edits must also advance the revision or wait for TTL; there is no public catalog-write endpoint.
- Cache errors fall back to database reads. Redis `noeviction` avoids dropping limiter counters under cache pressure; OOM consequently denies protected JSON rather than weakening protection. Use monitored, authenticated/TLS Redis services and separate capacity budgets before public hosting.

Run the local, sequential comparison with disposable test services:

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 npm run bench:cache
```

[The HTTP result and claim assessment](RESUME_CLAIM_VERIFICATION.md) supersede the older repository sample. Neither measures production capacity.

## Durable jobs and analytics

The `background_jobs` table is both the transactional outbox and queue. Event insertion and job enqueue commit together. Duplicate event retries do not enqueue duplicates. Jobs have a unique dedupe key, owner FK, status, attempt budget, availability time, lease/token, last error code and completion time.

Run workers with `npm run worker`; Compose runs one automatically. PostgreSQL workers claim distinct rows using `FOR UPDATE SKIP LOCKED`. SQLite uses serialized write transactions for local compatibility. A random lease token fences stale workers. Database work and acknowledgement share a transaction; a crash rolls back effects, and lease expiry allows another worker to retry. Failures back off exponentially (capped at 60 seconds), then become dead letters. Graceful shutdown stops claiming and waits for in-flight work.

Analytics jobs rebuild one owner's UTC day from authoritative events; they do not increment an already materialized total. Paused-playback intervals count, seek distance does not. `GET /api/analytics/rollups?days=7` returns only the current user's background snapshots (1–90 days accepted). The existing `/overview` remains the immediate source-based view. Snapshot lag is expected.

Maintenance is scheduled once per minute while a worker runs. Each pass limits expired session/token cleanup, deletes eligible expired guests older than seven days in batches, and retains completed jobs for 30 days. Registered and legacy users are not purged. Active sessions, guest upgrades and running owned jobs are respected. Old dead-email payloads are scrubbed; the old SQLite legacy event archive remains operator-managed.

Operator commands are CLI-only; there is no public job-admin endpoint:

```bash
npm run jobs -- list
npm run jobs -- backfill       # idempotently enqueue historical owner/day analytics
npm run jobs -- maintenance
npm run jobs -- retry JOB_UUID # dead non-email work only
```

Dead email needs a newly requested link rather than replaying an old encrypted payload. Job listing omits payloads. Error records contain bounded codes, not passwords, SMTP responses or reset links. Worker throughput, fairness, long outages and large backlogs have not been load-tested.

## Verification and password recovery

Set `EMAIL_MODE=smtp`, valid SMTP configuration and `EMAIL_ENCRYPTION_KEY`. Production accepts `smtps://` with certificate validation; STARTTLS-only providers are not configured. Set `MAIL_FROM` to a sender/domain your provider has verified. When email is disabled, registration still works unverified, but recovery/resend returns an explicit 503 rather than pretending to deliver.

Registration atomically queues a verification email. The account remains usable for public listening while unverified; `emailVerified` reports that distinction. Verification is not represented as authorization for private content or a mandatory listening gate.

- Verification tokens expire after 24 hours; reset tokens after 30 minutes. They contain 256 random bits, are stored hashed, are purpose-bound and can be consumed once.
- Email links use fragments. The recovery page removes the fragment from browser history and exchanges it via a CSRF-protected POST. Tokens do not enter HTTP request paths or access logs. Opening a new email link on an already-mounted recovery page is tested.
- Outbox delivery bodies use AES-256-GCM encryption. The key is deployment configuration, not database content. Completed jobs clear their payload. Consumed/superseded/expired token deliveries are skipped.
- Unknown and known reset requests return the same accepted body. That is not a strict timing-side-channel or anti-enumeration guarantee. Duplicate registration remains a conflict.
- Password reset and token consumption are transactional and revoke all owner sessions. Login locks/rechecks the password hash after verification to prevent an old-password login racing a reset from creating a surviving session.
- SMTP is **at least once**: stable Message-ID and skip checks help, but an accepted message followed by a crash before DB commit may be redelivered. No exactly-once internet-delivery claim is made. Network delivery holds a job transaction/connection and uses bounded transport timeouts; monitor this before increasing worker concurrency.

Protect the encryption key separately from backups. Rotating it without draining/cancelling pending email makes old ciphertext unreadable; request fresh links instead of retaining permanent fallback keys. Mailpit contains plaintext test messages and tokens, so keep it private and clear it when appropriate. No real external sender, deliverability, SPF/DKIM/DMARC or inbox-provider behavior was verified.

## PostgreSQL backup and restore drills

Tooling backs up the **SoundWave public schema**, not arbitrary additional schemas. Use PostgreSQL tools matching the server's major version. Native tools are selected through PATH or `PG_DUMP_BIN` / `PG_RESTORE_BIN`. For a local Docker database, `BACKUP_PG_CONTAINER` uses that container's matching tools; it must represent the same database server as `DATABASE_URL`.

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST/DATABASE \
  npm run db:backup -- create /secure/path/soundwave.dump

# Requires a role allowed to CREATE/DROP its generated verification database:
RESTORE_ADMIN_URL=postgres://RESTORE_OPERATOR:PASSWORD@HOST/DATABASE \
DATABASE_URL=postgres://USER:PASSWORD@HOST/DATABASE \
  npm run db:backup -- verify /secure/path/soundwave.dump
```

Local Docker alternative:

```bash
BACKUP_PG_CONTAINER=YOUR_POSTGRES_CONTAINER DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/DATABASE \
  npm run db:backup -- create /tmp/soundwave.dump
BACKUP_PG_CONTAINER=YOUR_POSTGRES_CONTAINER DATABASE_URL=postgres://CREATEDB_OPERATOR:PASSWORD@localhost:PORT/DATABASE \
  npm run db:backup -- verify /tmp/soundwave.dump
```

Creation exports a repeatable-read snapshot and passes it to `pg_dump`. A manifest records counts and order-independent content fingerprints for 14 app tables from the same snapshot, plus the archive's SHA-256. The archive and manifest use mode 0600; existing archives are never overwritten. These are sensitive database files, **not encrypted backups**.

Verification checks the archive hash first, creates a random `soundwave_restore_…` database, restores there, compares all 14 recorded table fingerprints and drops only that generated database. It never restores over the source. Schema-selective dumps include `CREATE SCHEMA public`, so the drill removes the new target's empty default schema before restoring. This is not an application migration or deletion of existing user tables.

Use only trusted archives and a dedicated restore operator. Integrity hashes are not signatures, and restoring SQL is not a safe way to inspect hostile dumps. The fingerprints detect accidental discrepancies; they are not a cross-major-version compatibility guarantee. A restore failure/crash may need operator cleanup of its generated scratch database. Real promotion, offsite/encrypted storage, retention scheduling, credential rotation after recovery, disaster recovery RPO/RTO and restore into managed hosting are not implemented or verified. Stop workers during any real recovery cutover so restored email jobs cannot unexpectedly replay.

## BullMQ media analysis

The media pipeline uses BullMQ 6.7.1 with Redis/ioredis. The API and worker images contain the same immutable source WAVs. The worker automatically checks the catalog at startup/every minute and schedules missing/version-changed metadata; it also continues the existing PostgreSQL analytics/email loop. Redis AOF and a named volume are configured with `noeviction`. Losing Redis without a usable persistence snapshot can lose queue history; the catalog scheduler can recreate missing derived work, but this is not an HA guarantee.

```bash
npm run media -- enqueue
npm run media -- list
npm run media -- retry FAILED_MEDIA_JOB_ID
```

A media job ID includes chapter, processor version and SHA-256 source digest. Defaults are four attempts, exponential backoff starting at one second, 30-second lock/stall intervals, up to two stalled recoveries, seven-day/1,000 completed retention and 30-day/1,000 failed retention. Invalid/missing/unsupported audio fails visibly; changed source files need `enqueue` with their new digest. Database results are conditionally upserted, so duplicate work does not change an already processed timestamp.

`GET /api/chapters/:id/metadata` returns 202 pending or actual stored codec, sample rate, channels, duration, RMS and waveform. Only catalog-owned paths are read. Supported media is RIFF/WAVE 16-bit PCM, mono/stereo at 8–192 kHz, at most 100 MB. It does not transcode MP3/AAC or accept uploads.

The Dockerfile has `api` and `worker` targets; plain build defaults to API. API health probes `/api/ready`; worker health checks its progress heartbeat, process existence and Redis/public worker state. Optional port variables `APP_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `MAILPIT_PORT`, `SMTP_PORT` avoid conflicts without override files. Keep `APP_ORIGIN` consistent with the exposed frontend port.

PostgreSQL is the startup default; set `DATABASE_URL`. For intentional legacy use, set `DATABASE_DRIVER=sqlite`; an explicitly supplied `DATABASE_PATH` also selects compatibility when the PostgreSQL driver was not explicitly chosen. The production PostgreSQL requirement remains unless the operator explicitly chooses the limited ephemeral demo exception.

Verification commands use disposable services:

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/test_database \
TEST_REDIS_URL=redis://localhost:PORT npm run test:media:restart
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/test_database \
TEST_REDIS_URL=redis://localhost:PORT TEST_REDIS_CONTAINER=soundwave-your-test-redis npm run test:redis:recovery
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/test_database \
TEST_REDIS_URL=redis://localhost:PORT npm run bench:http -- docs/http-load-results.json
```

The Redis recovery script deliberately stops/restarts the named local test container. It requires a loopback URL and a `soundwave-…` container name; never point it at an important service. The worker restart script uses its own Redis namespace and generated PostgreSQL schema, kills only its test child, then validates actual BullMQ recovery. See [latest verification](RESUME_CLAIM_VERIFICATION.md).
