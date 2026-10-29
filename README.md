# SoundWave

**Stories worth getting lost in.** An audio fiction platform built with React/Vite, Express, PostgreSQL and a SQLite compatibility adapter. It combines real byte-range audio delivery, resumable playback, libraries, rule-based discovery and selected offline downloads.

**[Live portfolio demo](https://soundwave-codeit-ronit.vercel.app/)** · **[Source](https://github.com/codeit-ronit/SOUNDWAVE)** · **[Architecture](docs/ARCHITECTURE.md)** · **[Operations](docs/OPERATIONS.md)** · **[Latest verification](docs/PHASE2_REPORT.md)**

**Deployment status:** The repository now includes PostgreSQL/authentication plus Redis protection, durable workers, email verification/recovery and backup tooling. It has been verified locally, including real PostgreSQL tests; it has **not been deployed to the public demo**. The live link still serves the earlier shared-user version with temporary Vercel SQLite storage. Do not use it for private data or as evidence of the new authentication deployment.

The submitted resume URL, [zippy-nitrogen-wd3scr3.tmp.now](https://zippy-nitrogen-wd3scr3.tmp.now/), redirects to the existing live demo. Retain its original claimed deployment and hostname-specific redirect. Use the main demo URL for future submissions.

![SoundWave desktop interface](docs/soundwave-desktop.png)

The screenshot shows the earlier interface; the current app replaces the fixed demo profile with account controls. No real-user, production-readiness or scalability claim is made.

## Run locally

Requires **Node.js 22.x and npm**. The verified host used Node 22.21.1 and Google Chrome. All twelve audio files are bundled; no API key, paid service or audio generation is needed.

```bash
git clone https://github.com/codeit-ronit/SOUNDWAVE.git
cd SOUNDWAVE
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. Express runs on port 3001; Vite proxies `/api` and `/audio`. Without `DATABASE_URL`, local development keeps SQLite at `server/data/soundwave.sqlite`, applies additive auth migrations and seeds the catalog. Existing shared-listener data remains under an unclaimable legacy owner rather than becoming every visitor's account.

To use PostgreSQL with the Node development server:

1. Set a strong URL-safe `POSTGRES_PASSWORD` in `.env`.
2. Start the database and configure the connection:

   ```bash
   docker compose up -d postgres
   # Add DATABASE_URL to .env, replacing the password with your actual value:
   # DATABASE_URL=postgres://soundwave:YOUR_URL_ENCODED_PASSWORD@localhost:5432/soundwave
   npm run db:migrate
   npm run dev
   ```

Migrations and catalog seeding also run at startup. PostgreSQL is the primary configured backend; SQLite remains a compatibility/local option. Do not point tests at a database containing important data.

For the production frontend bundle and offline support:

```bash
npm run build
npm start
# Open http://localhost:3001
```

This runs the production **frontend bundle** using local development cookie settings unless `NODE_ENV=production` is explicitly set. The service worker is disabled during Vite development. Public production mode requires HTTPS `APP_ORIGIN` and PostgreSQL.

## Redis, jobs and account recovery

The next phase is implemented. Redis shares API/auth rate limits across instances; catalog caching is optional and never stores personal state. A PostgreSQL outbox/worker handles analytics snapshots, expired session/guest cleanup and SMTP delivery. Verification/reset links are hashed, expiring and single-use; resets revoke all sessions. Backup tooling verifies a snapshot by restoring into a fresh disposable database.

Run `npm run worker` alongside host-side development. Compose starts the worker automatically. See [OPERATIONS.md](docs/OPERATIONS.md) for configuration, delivery semantics, job administration and backup/restore commands.

## Docker Compose

With `POSTGRES_PASSWORD` set in `.env`, Compose runs PostgreSQL, Redis, API, worker and a local SMTP catcher. For email features, also set `EMAIL_MODE=smtp` and a random `EMAIL_ENCRYPTION_KEY` as described in [Operations](docs/OPERATIONS.md#complete-local-stack). Without mail configuration, recovery reports an explicit error; it does not fake delivery.

For Compose, leave `SMTP_URL` unset so it uses `smtp://mailpit:1025`. Then:

```bash
docker compose up --build
# Open http://localhost:3001
```

Compose defines PostgreSQL 18.6, Redis 7.4 with a bounded memory budget, dependency checks, persistent database/Redis volumes and a non-root Node application/worker. The local inbox is http://localhost:8025. Exposed ports bind to loopback. Default `APP_NODE_ENV=development` deliberately supports localhost HTTP cookies. To host publicly, set `APP_NODE_ENV=production`, supply an HTTPS `APP_ORIGIN`, configure TLS termination and protect the database network. Do not expose the development configuration publicly. See the verification report for the actual container-build result.

`docker compose down` keeps the database volume. Do not use `down -v` when preserving data. Reserved URL characters in passwords must be percent-encoded in `DATABASE_URL`.

## Configuration

Copy `.env.example`; never commit real credentials.

| Variable                 | Behavior                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | PostgreSQL connection string; takes precedence over SQLite                                                   |
| `DATABASE_PATH`          | SQLite path for local compatibility; default `server/data/soundwave.sqlite`                                  |
| `APP_ORIGIN`             | Exact app origin; required HTTPS origin in production                                                        |
| `NODE_ENV`               | `production` enforces HTTPS configuration, Secure cookies and PostgreSQL by default                          |
| `CLIENT_ORIGIN`          | Development-only CORS origins; default localhost/127.0.0.1 port 5173                                         |
| `PORT`                   | Express port, default `3001`; Vite proxy also targets 3001                                                   |
| `DB_POOL_MAX`            | PostgreSQL pool limit per process, default `5`                                                               |
| `PGSSL`                  | Set `true` for PostgreSQL TLS with certificate verification; configure trusted CAs as needed                 |
| `DEMO_MODE`              | Default `true`; `false` disables independent guest-account creation                                          |
| `SESSION_TTL_SECONDS`    | Registered session absolute lifetime, default `604800` (7 days), maximum 30 days                             |
| `GUEST_TTL_SECONDS`      | Guest session lifetime, default `86400` (1 day), maximum 7 days                                              |
| `HTTP_LOG`               | Set `1` for structured request IDs, paths, status and duration; no request bodies                            |
| `POSTGRES_PASSWORD`      | Compose database password; also used to construct its internal connection URL                                |
| `APP_NODE_ENV`           | Compose app environment; default local `development`                                                         |
| `REDIS_URL`              | Enables shared atomic limits; configured outages fail closed for JSON, with audio exempt                     |
| `REDIS_PREFIX`           | Shared deployment namespace, default `soundwave`                                                             |
| `CATALOG_CACHE`          | `true` opts into bounded public catalog/search caching; default off after local measurements showed overhead |
| `TRUSTED_PROXY_CIDRS`    | Exact real proxy IPs/subnets; forwarding headers are ignored by default; /0 trust rejected                   |
| `EMAIL_MODE`             | `disabled` or `smtp`; disabled delivery never claims to send recovery mail                                   |
| `SMTP_URL`               | `smtp://` for local capture; production requires `smtps://` with certificate validation                      |
| `EMAIL_ENCRYPTION_KEY`   | Required SMTP outbox AES-256-GCM key: 32 random bytes encoded as 64 hex characters                           |
| `MAIL_FROM`              | Sender identity; configure a provider-verified sender before external delivery                               |
| `ALLOW_EPHEMERAL_SQLITE` | Explicit production portfolio fallback only; never a substitute for durable PostgreSQL                       |

The default frontend/API deployment is same-origin. Production CORS permits only `APP_ORIGIN`; it does not reflect arbitrary origins. Custom split-origin cookie deployments are not configured or verified.

## Implemented foundation

- **PostgreSQL persistence:** a small `pg` adapter and bounded pool; normalized users, sessions, catalog and owner-scoped tables; foreign keys, uniqueness, checks and indexes; connection-pinned transactions.
- **Versioned migrations:** transactional SQL files with checksums and migration locks. SQLite upgrades preserve existing listener rows and archive the original event table. No destructive reset or automatic rollback migration.
- **Registration/login/logout:** validated inputs, scrypt password hashes, opaque HTTP-only sessions, absolute expiration, token rotation, CSRF validation and authentication throttling. Production cookies also use Secure and a `__Host-` name.
- **User isolation:** library, favorites, progress, recommendations and analytics resolve identity from the session. Client-supplied user IDs never select an owner. Event idempotency and playback ordering are owner-scoped.
- **Convenient demo:** each new visitor receives an isolated guest session when enabled. Guests cannot select existing users. Registration upgrades the guest transactionally and retains its saved data; login to another account does not silently merge histories.
- **Frontend integration:** account form, invalid-login feedback, sign-out, state reset on account changes, stale queued-write protection and cross-tab account-change notification.
- **Offline privacy:** sessions and private API results are not persisted in service-worker caches. Explicit downloads contain public catalog metadata with neutral progress/favorite state and remain available on the same device.

### Preserved listening features

- Six original stories across five genres and twelve bundled narrated chapters.
- One persistent HTML5 audio player across routes, chapter transitions, resume after refresh, Continue Listening, buffering/error states, volume and mute.
- Playback speeds from 0.75× to 2×, device-local speed preference, 5/15/30-minute sleep timers and keyboard controls. **Space** toggles playback after clicking Start/player buttons; **← / →** seeks ten seconds. Text fields, selects and sliders retain their native controls.
- Backend title/genre search, exact genre filters, allowed sorts, URL query state and loading/empty/error states.
- Favorites and My Library; deterministic recommendations weighted by favorite genres and listening history. This is **rule-based personalization**, with curated seed popularity, not ML or real engagement data.
- Explicit PWA chapter downloads, offline shell/playback/seeking/removal, full-file validation and quota-error feedback. No automatic catalog-wide audio caching.
- Event-based listening analytics, a seven-day UTC chart, genre summaries, recent activity and completion/favorite counts. Seek distance never becomes listening time; duplicate events are idempotent.

## Distributed protection and background operations

- **Shared rate limits:** atomic Redis counters for API, auth IP and target-account buckets; bounded queues/timeouts, expiry, explicit proxy trust and 503 on configured Redis failure. Streaming remains available during an outage.
- **Optional cache:** neutral catalog/search/genre results, owner-specific favorite overlays, transactional revision invalidation, 128 slots per revision and 60-second TTL. No session cache or shared private results.
- **Durable work:** transactional event/outbox writes, concurrent worker claims, lease fencing, rollback/retry/backoff, dead letters, graceful shutdown, historical analytics backfill and cleanup batches.
- **Email flows:** registration verification, resend, forgot-password and reset forms; 24-hour verification and 30-minute reset tokens; encrypted delivery payloads, one-time consumption, token invalidation and session revocation.
- **Recovery drills:** public-schema snapshot archives, restricted file permissions, checksum/fingerprint manifests and isolated restore verification. No source database is overwritten.

The recorded six-story local cache sample was slower with Redis (p50 0.736 ms versus 0.498 ms direct), so caching is opt-in. This demonstrates measured tradeoffs, not a speedup or scalability claim. See [the sample](docs/cache-benchmark.json).

## Try the new account flow locally

1. Open the app: an independent demo guest is created. Play a chapter, favorite a story and pause.
2. Click **Sign in → Create a new account**. Register with an email, name and password of at least twelve characters. The guest's library/history is retained.
3. Sign out. Log in with a wrong password to show validation, then with the correct password to restore the account.
4. Open a separate browser profile/private context: that visitor has a different demo library and history. Two tabs in the same profile intentionally share the cookie/account.
5. Search `mystery`, sort by title, change speed, and check Insights. Finish a chapter to verify automatic advancement.
6. With local SMTP configured, follow the verification email in Mailpit, then use **Forgot password?** and reset the password. The worker delivers to the local inbox; no real external email is sent.
7. In the built app, choose **Save offline** for a chapter, open Downloads, disconnect the browser network, then play, seek and remove it. Reconnect when done. Private API writes are not queued offline.

## Architecture and schema

```text
React/Vite → Express validation + session/CSRF middleware
             → business services → repositories → async adapter
                                             ├─ PostgreSQL (DATABASE_URL)
                                             └─ SQLite (local compatibility)
Browser service worker → shell + selected public audio/metadata
```

The application remains a modular monolith. Public media still streams from bundled files. A separate worker process uses the same codebase and database; no microservice fleet, upload/transcoding pipeline or CDN was added.

| Location                                              | Responsibility                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `server/config.js`                                    | Validated environment configuration                                              |
| `server/database/`                                    | PostgreSQL/SQLite adapters, migrations, catalog seed and read-only-source import |
| `server/migrations/postgres/`                         | Core/session/cache/job/recovery SQL migrations                                   |
| `server/migrations/sqlite/`                           | Additive auth, event ownership and owner guards                                  |
| `server/infrastructure/redis.js`                      | Distributed counters and neutral catalog cache                                   |
| `server/jobs/`                                        | Durable queue, worker handlers and analytics backfill                            |
| `server/operations/backup.js`                         | Snapshot backup and isolated restore verification                                |
| `server/routes/`                                      | HTTP endpoints, validation and status codes                                      |
| `server/services/`                                    | Authentication/password hashing, resume/discovery rules and analytics assembly   |
| `server/repositories/`                                | Identity, catalog, listening writes and analytics queries                        |
| `server/middleware/`                                  | Session identity, CSRF, request IDs and process-local rate limits                |
| `client/src/AuthContext.jsx`                          | Account bootstrap, form and identity transitions                                 |
| `client/src/PlayerContext.jsx`                        | Audio lifecycle, progress ordering, timers and transitions                       |
| `client/src/OfflineContext.jsx`, `offlineMetadata.js` | Downloads and public metadata boundary                                           |
| `client/public/sw.js`                                 | Versioned shell and range-aware selected audio                                   |
| `server/test/`, `client/src/*.test.*`                 | Integration and frontend regressions                                             |
| `scripts/*smoke.mjs`                                  | Browser playback, offline, auth, restart and keyboard checks                     |
| `api/index.js`, `vercel.json`                         | Serverless adapter and bundle/routing configuration                              |

Core relations are `users`, `sessions`, `stories`, `chapters`, `favorites`, `listening_progress`, `progress_write_versions`, `listening_events` and `schema_migrations`, with `account_tokens`, `background_jobs`, `analytics_rollups` and `catalog_revision` added for operations. Owned rows have composite user/resource keys; PostgreSQL enforces ownership references with foreign keys. Events use `(user_id,event_id)`, allowing each owner an independent idempotency namespace.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for constraints, transaction boundaries, guest upgrades, password costs, cache isolation and migration tradeoffs.

## Migrations and existing SQLite data

```bash
npm run db:migrate
# With DATABASE_URL set, explicitly import an existing SQLite file:
npm run db:import:sqlite -- /absolute/path/to/soundwave.sqlite
```

Back up both databases before a real cutover. The importer opens the source read-only at a consistent snapshot and writes PostgreSQL in one transaction. IDs/timestamps are retained; existing target keys are not overwritten, and session tokens are not imported. Repeating an import does not duplicate rows. Review inserted counts and resolve conflicts; a completed command does not mean conflicting target data was reconciled. Legacy `demo-user` data is preserved but cannot be claimed through public authentication.

`npm run seed` applies initialization and updates the catalog without clearing listener data. Runtime database files and `.env` are ignored by Git.

## REST API

All endpoints use `/api`. JSON errors use `{ "error": { "message": "..." } }`. Responses carry `X-Request-ID`. Private JSON uses `Cache-Control: private, no-store` and `Vary: Cookie`.

| Method       | Path                               | Access / behavior                                                                                       |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET          | `/auth/session`                    | Pre-login session or current sanitized identity, CSRF token, expiry and demo availability; never cached |
| POST         | `/auth/demo`                       | CSRF-protected independent guest creation; only when enabled and signed out                             |
| POST         | `/auth/register`                   | `{ email, password, displayName }`; create account or upgrade current guest                             |
| POST         | `/auth/login`                      | `{ email, password }`; rotate session on valid credentials                                              |
| POST         | `/auth/forgot-password`            | Generic accepted response; queues reset mail when configured                                            |
| POST         | `/auth/request-verification`       | Resend for current registered account; session + CSRF                                                   |
| POST         | `/auth/verify-email`               | One-use `{ token }`; CSRF                                                                               |
| POST         | `/auth/reset-password`             | `{ token, password }`; reset and all-session revocation; CSRF                                           |
| GET          | `/ready`                           | Database/Redis dependency readiness                                                                     |
| POST         | `/auth/logout`                     | CSRF-protected revocation; 204                                                                          |
| GET          | `/health`                          | Database connectivity and adapter type; public                                                          |
| GET          | `/genres`                          | Public genre list                                                                                       |
| GET          | `/stories?q=&genre=&sort=trending` | Public catalog; current user's favorite flags only                                                      |
| GET          | `/stories/:id`                     | Public story details                                                                                    |
| GET          | `/stories/:id/chapters`            | Chapters with current user's progress, neutral for anonymous visitors                                   |
| GET          | `/library`                         | Current user's favorites; session required                                                              |
| PUT / DELETE | `/library/:storyId`                | Idempotent current-user favorite changes; session + CSRF                                                |
| GET          | `/progress`                        | Current-user progress and Continue Listening; session required                                          |
| PUT          | `/progress/:chapterId`             | `{ positionSeconds, completed?, clientId?, sequence? }`; session + CSRF                                 |
| GET          | `/recommendations`                 | Rule-based current-user suggestions; public fallback when anonymous                                     |
| POST         | `/analytics/events`                | `{ id, type, chapterId, listeningSeconds?, playbackRate? }`; session + CSRF                             |
| GET          | `/analytics/rollups?days=7`        | Current-user background snapshots; session required                                                     |
| GET          | `/analytics/overview`              | Current-user totals, genres, daily activity and recent events; session required                         |
| GET / HEAD   | `/chapters/:id/stream`             | Public full/range audio with validated file resolution                                                  |

For unsafe requests, first obtain a session cookie and CSRF token through `/auth/session`, then send that cookie and `X-CSRF-Token`. The frontend handles this exchange. Missing/expired private identity returns 401; failed CSRF returns 403; conflicting events/account guards return 409; invalid inputs return 400. JSON is limited to 8 KB; excessive requests return 429 and Retry-After.

`q` is limited to 100 characters; `genre` to 40; `sort` allows only `trending`, `title`, `newest`. Prepared parameter binding treats SQL injection and wildcard input as data. Progress requires a finite position within chapter duration; completed chapters must be at their end. Paused/seek/chapter saves are acknowledged; unload saves remain best effort. Same-client version checks reject stale saves; independent clients still use last-arriving writes.

Audio returns **200** for full GET/HEAD, **206** for one valid bounded/open/suffix range, and **416** for malformed/multiple/unsatisfiable ranges. HEAD has no body and ignores Range. If-Range, ETag, Last-Modified and exact content lengths are supported. Both stream and legacy `/audio` routes validate catalog mappings and real paths, including symlinks. Multipart ranges are not implemented.

## Verification

```bash
npm test                    # SQLite compatibility, real-session auth and frontend tests
npm run build
npm run test:browser         # existing playback/library/search/analytics browser scenario
npm run test:offline         # selected downloads, range seeking, quota errors
npm run test:audit           # real Node restarts and save/analytics regression checks
npm run test:keyboard
npm run test:auth:browser
npm run format:check

# Additional real PostgreSQL tests; use a disposable local database.
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/soundwave_test npm test
# Full backend/Redis/restore suite (source public schema must be migrated first):
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 TEST_BACKUP_CONTAINER=YOUR_POSTGRES_CONTAINER npm test
# Separate API/worker, captured SMTP and browser flows (all URLs must be loopback):
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 TEST_SMTP_URL=smtp://localhost:1025 \
TEST_MAILPIT_URL=http://localhost:8025 npm run test:systems
# Browser auth and restart checks can also use a disposable PostgreSQL database:
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/soundwave_test npm run test:auth:browser
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/soundwave_test npm run test:audit
```

Database tests create/remove random schemas; restore/system tests additionally create/drop generated databases, so their disposable test role needs the corresponding privileges. `TEST_BACKUP_CONTAINER` must match the same local server as `TEST_DATABASE_URL`. Without it, PostgreSQL cases are not run; the suite still tests real sessions with SQLite. Browser PostgreSQL scripts seed/write the supplied database and must use disposable data.

**Latest executed checkpoint:** 90 backend tests with real PostgreSQL, Redis and backup tools enabled, plus 26 frontend tests passed (**116 total, zero failures**). Existing core, offline, keyboard and SQLite restart checks passed; new auth and restart browser checks also passed against PostgreSQL. [PHASE2_REPORT.md](docs/PHASE2_REPORT.md) records exact commands, counts, repaired failures, SMTP/worker checks and restore results. [PHASE1_REPORT.md](docs/PHASE1_REPORT.md) preserves the earlier checkpoint. The earlier [FINAL_AUDIT.md](FINAL_AUDIT.md) is historical evidence for the pre-auth demo, not a Phase 1 deployment/security certification.

Browser scripts use `CHROME_PATH`, installed macOS Chrome, or Playwright Chromium. If needed, run `npx playwright install chromium`. Chrome coverage does not establish Safari/Firefox, native OS installation or physical-mobile compatibility.

## Deployment and remaining work

The existing Vercel URL still serves the earlier version. Before deploying the current version, provision persistent PostgreSQL and Redis, a long-running worker host, and a verified SMTP sender. Then set `DATABASE_URL`, `NODE_ENV=production` and an exact HTTPS `APP_ORIGIN`, configure verified database TLS where applicable, apply/review migrations, and test sign-in/isolation/restart behavior at the public origin. Pool size must fit the provider's connection budget. Vercel packaging includes SQL migrations and audio, with SPA/API rewrites. No managed Redis/SMTP/database deployment or public rollout was performed. Vercel API hosting additionally needs a separately hosted supervised worker; Mailpit is local-only.

```bash
# After configuring and verifying the production database/environment:
npx vercel link --yes --project zippy-nitrogen-wd3scr3 --scope ronit-choudharys-projects
npx vercel deploy --prod --yes --scope ronit-choudharys-projects
```

Use a remote Linux build for native SQLite dependencies; never upload a Mac-built serverless function. A Node host can serve the app with `npm ci`, `npm run build`, `npm start`, a separately supervised `npm run worker`, HTTPS termination, persistent PostgreSQL and Redis. A serverless API alone does not run the durable worker. Retain bundled audio and SPA routing. GitHub pushes alone are not verified to deploy this project.

Remaining gaps include MFA, account deletion, private content entitlements, offline private-data synchronization, managed production deployment/TLS, database role separation, scheduled encrypted/offsite backups, full disaster-recovery promotion, security review and load testing. Verification, recovery, cleanup, distributed limits and local restore drills are implemented; external internet delivery is not verified. Audio remains a small bundled catalog. Browser downloads are public content stored on one device and can be evicted. Analytics are bounded client-observed demo metrics, not tamper-proof engagement tracking.

See [Operations](docs/OPERATIONS.md) and the [architecture document](docs/ARCHITECTURE.md) for Redis/worker/email/backup behavior and remaining operational work.

## Audio and artwork

The twelve original 32–37-second chapters are mono 22.05 kHz PCM WAV files, approximately 18 MB total, narrated with the macOS Samantha voice from `server/content/catalog.js`. They are bundled with measured durations. Covers use original CSS/vector compositions and Lucide icons (ISC).

Optional macOS-only regeneration is `npm run audio:generate`, then `npm run seed`. The generator reuses existing WAVs; remove a specific generated file before regenerating an edited script. Normal setup does not invoke it.
