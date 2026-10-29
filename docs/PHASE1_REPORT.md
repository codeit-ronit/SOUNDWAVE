# Phase 1 implementation and verification report

**Date:** 29 October 2026. **Baseline:** `bb08c24`. **Implementation checkpoint:** `31d55ec`, followed by the verified transactional guest-session and database-readiness fixes recorded in repository history.

Scope is PostgreSQL, authentication and user isolation within the existing application. The React/Vite and Express application was extended, not rebuilt. This report supersedes pre-auth claims in `FINAL_AUDIT.md` for the current repository; the old audit remains historical evidence.

## Delivered

| Area                            | Result                         | Evidence and boundaries                                                                                                                                                                                   |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL adapter and schema   | PASS                           | Real PostgreSQL 18.6; pooled `pg`, parameter binding, owner FKs/unique keys/checks/indexes, pinned transactions and per-owner/chapter progress locks                                                      |
| Versioned migrations            | PASS                           | Fresh schemas, simultaneous migration runners, reruns, checksum rejection and transaction rollback tested; SQL files retained in source                                                                   |
| Existing data preservation      | PASS within tested fixtures    | Pre-auth SQLite upgrade preserves favorite/progress/event rows; old event table retained; repeatable read-only-source import into PostgreSQL preserves data and does not overwrite target keys            |
| Registration/login/logout       | PASS within tested cases       | Real scrypt hashes, cookie flags, session rotation, hashed token storage, invalid credentials, cookie replay after logout and absolute expiry                                                             |
| CSRF and origin checks          | PASS within tested cases       | Missing/invalid/Unicode tokens, cross-origin and cross-site metadata rejected; valid writes work; production cookie flags verified with HTTPS configuration                                               |
| Ownership and authorization     | PASS within tested cases       | Two registered accounts and independent guest accounts; libraries, progress, analytics, chapter state, recommendations and idempotency separated; body/query/header identity spoofing rejected or ignored |
| Demo behavior                   | PASS                           | Automatic isolated guest bootstrap, disabling demo does not enable a fallback identity, guest registration retains owned rows; legacy shared user cannot sign in                                          |
| Existing listening behavior     | PASS in Chrome                 | Actual audio, ranges, routing, favorites, resume, chapter transitions, analytics, search, speed/timer/keyboard controls and offline download/removal/quota scenarios                                      |
| Cache privacy                   | PASS within tested cases       | Sessions/library/progress/analytics absent from Cache Storage; unit test strips unexpected identity and personalized fields from download metadata                                                        |
| Server restart persistence      | PASS                           | Actual Node process restart scripts pass on SQLite and PostgreSQL, keeping session identity, exact listener data and event idempotency                                                                    |
| Containers                      | PASS locally                   | Docker build, non-root runtime, Compose health/dependency configuration, app registration and simultaneous app/database restart persistence verified with loopback port overrides                         |
| Frontend build and formatting   | PASS                           | Production Vite bundle and formatting/diff checks                                                                                                                                                         |
| Public Phase 1 deployment       | NOT IMPLEMENTED / NOT VERIFIED | Existing Vercel live link remains the earlier shared demo. No managed PostgreSQL service, production auth environment or public Phase 1 URL was provisioned                                               |
| Production security/scalability | NOT VERIFIED                   | No penetration test, multi-instance/load benchmark, database TLS deployment, backup drill or operational certification                                                                                    |

## Exact automated results

Final command, using an isolated local PostgreSQL container:

```bash
TEST_DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave npm test
```

**63 backend tests + 22 frontend tests = 85 passed, 0 failed, 0 skipped.**

The PostgreSQL test role creates and drops random test schemas. These are disposable fixture schemas, not a destructive application migration. No important user database was reset.

The original 40 endpoint tests remain, with an explicit test-only injected identity. New real-session tests exercise both adapters. Additional coverage includes production cookie configuration, real legacy SQLite migration, PostgreSQL concurrent migrations/import constraints, sanitized offline metadata and bounded startup retries. A normal `npm test` without `TEST_DATABASE_URL` does not execute the PostgreSQL-specific cases; do not present that run as PostgreSQL verification.

Other executed commands:

| Command                                                                                                        | Result                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline `npm test` before changes                                                                             | 40 backend + 21 frontend = 61 passed                                                                                                           |
| `npm run build`                                                                                                | PASS; final host Vite build compiled 1,699 modules and generated the offline shell                                                             |
| `node scripts/browser-smoke.mjs`                                                                               | 14 checks passed; real audio/library/resume/transitions/analytics/search/mobile layout                                                         |
| `node scripts/offline-smoke.mjs`                                                                               | 13 checks passed; worker, complete downloads, offline media/ranges/removal, speed/timer/keyboard and injected quota/partial/truncated failures |
| `node scripts/keyboard-smoke.mjs`                                                                              | 3 checks passed; focused Start/player controls and unaffected search typing                                                                    |
| `node scripts/audit-smoke.mjs`                                                                                 | 7 SQLite process-restart/security/browser checks passed                                                                                        |
| `DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave node scripts/auth-smoke.mjs`  | 5 PostgreSQL browser checks passed; guest, registration, logout/login, visitor isolation, private-cache absence                                |
| `DATABASE_URL=postgres://postgres:soundwave-local-only@127.0.0.1:55433/soundwave node scripts/audit-smoke.mjs` | 7 PostgreSQL process-restart/security/browser checks passed                                                                                    |
| `DATABASE_URL=… npm run db:migrate` and `npm run seed`                                                         | PASS against disposable PostgreSQL; repeat initialization preserves listener rows                                                              |
| `POSTGRES_PASSWORD=… docker compose config -q`                                                                 | PASS                                                                                                                                           |
| `docker build -t soundwave:phase1 .`                                                                           | PASS; native dependencies installed in Linux, app runs as UID 1000 (`node`)                                                                    |
| Compose `up -d --build`                                                                                        | PASS using alternate loopback ports and an isolated project/volume                                                                             |
| `node scripts/container-smoke.mjs … seed …` / `verify …`                                                       | PASS; registration, favorite, 8.25-second progress and exact analytics survive app/database restart and app recreation                         |
| `node scripts/keyboard-smoke.mjs http://127.0.0.1:53001`                                                       | 3 additional checks passed against the built Docker app                                                                                        |
| Formatting and `git diff --check`                                                                              | PASS                                                                                                                                           |

There are **49 local browser/process checks** across the core/offline/keyboard/auth and two restart runs above, plus three additional keyboard checks on the Docker app and two container-state phases. These are scenario assertions, not extra unit-test counts. The five-minute sleep-timer scenario accelerates the browser clock. Fault-injection checks deliberately simulate malformed downloads and quota errors.

Host: macOS, Node 22.21.1, Google Chrome. Container runtime: Linux ARM64, Node 22.23.4; PostgreSQL image `postgres:18.6-trixie`. Other architectures/browsers and physical hardware are not verified.

## Container reproduction

The default Compose ports may conflict with existing local apps. Verification used the committed `compose.yaml` plus this temporary override:

```yaml
services:
  postgres:
    ports: !override ["127.0.0.1:53032:5432"]
  app:
    ports: !override ["127.0.0.1:53002:3001"]
    environment:
      APP_ORIGIN: http://127.0.0.1:53002
```

With this override saved as `/tmp/soundwave-compose-audit.yaml`:

```bash
POSTGRES_PASSWORD=soundwave-local-only docker compose -p soundwave-phase1 \
  -f compose.yaml -f /tmp/soundwave-compose-audit.yaml up -d --build
node scripts/container-smoke.mjs http://127.0.0.1:53002 seed /tmp/soundwave-state.json
POSTGRES_PASSWORD=soundwave-local-only docker compose -p soundwave-phase1 \
  -f compose.yaml -f /tmp/soundwave-compose-audit.yaml restart postgres app
# Wait until the database is healthy and the app accepts requests, then:
node scripts/container-smoke.mjs http://127.0.0.1:53002 verify /tmp/soundwave-state.json
```

The state fixture contains a test session cookie and is written with mode 0600; never commit it. The example password is local fixture data, not a public deployment credential. Verification used a named database volume and did not remove it during the restart.

## Failures found and fixed

1. **SQLite assumptions in SQL:** PostgreSQL folds unquoted mixed-case aliases; analytics initially failed with SQLSTATE 42703. Quoted aliases and adapter-owned date/order expressions now pass the same ownership/analytics scenarios on PostgreSQL.
2. **Development CSRF origin:** temporary browser servers use random ports. The initial strict check blocked their guest bootstrap. Local mode now recognizes its actual same-origin URL; production remains restricted to the configured HTTPS origin.
3. **Logout self-reload:** a new BroadcastChannel sender also notified the persistent listener in its own tab, causing reload and automatic guest creation. Sender IDs suppress self-notifications. Browser tests now verify post-logout private reads return 401 before login.
4. **CSRF comparison:** fixed-length Unicode strings could have different byte lengths and make `timingSafeEqual` throw. Tokens now require 64 lowercase hex characters before comparison; regression tests expect 403.
5. **Guest atomicity:** guest creation, session issuance and previous-session revocation now share one transaction instead of committing the guest before revocation.
6. **Container startup race:** a simultaneous PostgreSQL/app restart returned SQLSTATE 57P03 while the database was starting, exiting the app. Startup now retries only recognized transient connectivity errors with bounded backoff; configuration/schema/checksum errors fail immediately. Compose adds a bounded app restart policy. The simultaneous restart was repeated successfully.

The image build initially stalled during a base-layer download; it later completed, and the final source was rebuilt before container verification. No successful container claim is based solely on configuration parsing.

## Modified files and responsibilities

- **Database/config:** `server/config.js`, `server/db.js`, `server/database/{adapter,index,migrate,seed,import-sqlite,retry}.js`, PostgreSQL `001_core.sql`/`002_sessions.sql`, SQLite `001_auth.sql`/`002_event_ownership.sql`/`003_owner_guards.sql`.
- **Auth and business boundaries:** `server/middleware/auth.js`, `server/routes/{auth,api,analytics,stream}.js`, `server/services/{auth,passwords,discovery,analytics}.js`, `server/repositories/{identity,catalog,listening,analytics}.js`.
- **Startup/tooling:** `server/index.js`, `server/scripts/{seed,migrate}.js`, `api/index.js`, `vercel.json`, root/server package manifests and lockfile.
- **Client:** `AuthContext.jsx`, `App.jsx`, `main.jsx`, `api.js`, player/library/offline contexts, `offlineMetadata.js`, styles and service worker. Existing layout/player pages are retained; the fixed demo badge becomes account controls.
- **Tests:** new `server/test/{auth,migration,retry}.test.js`, test-only `helpers.js`, updated existing test imports, `client/src/offlineMetadata.test.js`, new auth/container smoke scripts and the session-aware restart script.
- **Operations/docs:** `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.example`, `README.md`, `docs/ARCHITECTURE.md`, this report. Screenshots remain historical; generated smoke-test screenshot changes were not committed.

## Remaining concerns and next steps

Phase 1 is complete within its tested local scope. It is not a public production launch.

- Provision a persistent managed PostgreSQL database, app/migration roles, verified TLS, secrets, backup/restore procedures and HTTPS before a public auth deployment. Test actual public cookie/origin behavior and data survival before replacing the live demo.
- Add session/guest retention and cleanup; expiry is enforced but expired rows and guest records are not automatically purged. The preserved SQLite event archive also needs an explicit operator retention decision.
- Email verification, password recovery/change, MFA, account deletion and trusted-account abuse controls are not implemented. Duplicate registration returns a conflict, so account existence can be inferred; no anti-enumeration guarantee is made.
- Current limits and password-work caps are process-local. Configure explicit trusted-proxy handling and measure multi-user behavior before claiming distributed abuse resistance or throughput.
- Offline audio is public device-wide content. Private API state is neither cached nor queued offline. There is no entitlement/DRM model, private offline synchronization or multi-device progress conflict resolution.
- Client-observed analytics can be forged or undercount offline/background events. Aggregate responses are several queries, not a guaranteed concurrent snapshot. No load, stress, failover, prolonged outage or large-catalog benchmark was run.
- Safari/Firefox, native OS installation, physical mobile hardware and cross-architecture Docker builds remain unverified.

**Redis recommendation:** implement distributed API/auth throttling first with bounded keys/TTLs and tested proxy/IP semantics. Then measure whether public catalog/search caching helps. Include owner identity and invalidation in any personalized keys; preserve session revocation and fail closed on cache failure. PostgreSQL remains authoritative.

**Background-job recommendation:** begin with expired-session/guest maintenance and analytics rollups. Use a transactional outbox, owner-aware idempotency keys, bounded retries/backoff, dead-letter visibility and graceful shutdown. Add a queue such as BullMQ only when its operational cost is justified. Keep acknowledged playback writes transactional and synchronous. Redis, queues and workers are deliberately not implemented in Phase 1.
