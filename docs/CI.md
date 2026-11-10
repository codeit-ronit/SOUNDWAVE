# GitHub Actions CI — M6.1 early delivery

**Remote status: NOT RUN / NOT VERIFIED.** This branch has not been pushed and no GitHub Actions run or branch protection setting was created. Local validation is evidence about the commands/workflow, not a successful hosted run. See [local results](ci-verification.json) and [flake investigation](CI_FLAKE_INVESTIGATION.md).

## Required PR gates

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on pull requests, pushes to main/the current feature branch, and manual dispatch. It uses Ubuntu 24.04, Node **22**, PostgreSQL **18.6** and Redis **7.4**. Actions are pinned to official release commit SHAs. Their internal action runtime is Node 24; application installation, tests and build explicitly use Node 22. Checkout has no persisted Git credentials; workflow token permissions are read-only. No `pull_request_target`, environment secrets, deployment credentials or privileged external writes are used. npm caches package downloads, not `node_modules`; every job runs clean `npm ci`.

| Job                             | Mandatory checks                                                                                                                                                                                               | Bounds                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tests, migrations and build** | CI safety tests; fresh database migrations/seed; complete backend/frontend suite with real PostgreSQL/Redis/backup tools; production build; formatting                                                         | 15-minute job; individual commands have timeouts; critical integration result names and zero skipped backend cases are checked after the suite |
| **Browser regression smoke**    | Fresh install/build, lockfile-matched Playwright Chromium/OS dependencies; login, PostgreSQL playlists/settings/queue/real playback, offline WAV downloads/range seeking/storage failures, restart/persistence | 15-minute job; sequential scripts, 3-minute per-script deadline; no test retries                                                               |

If configuring branch protection later, use those two job names after a successful real run. The workflow cannot enforce repository settings itself; none were changed by this task. Fork PRs may require GitHub's normal maintainer approval. The optional job must not be a required PR check.

## Optional checks

Manual dispatch with `extended=true` adds a separate **Optional systems and load checks** job (25-minute bound): real local SMTP capture with separate API/worker, worker crash recovery, combined demo supervisor recovery and the existing synthetic local HTTP benchmark. It creates its own PostgreSQL/Redis/Mailpit services. It does not send external email, import the live provider catalog, stop shared services or test production capacity. Provider import, Docker rebuilds and larger/manual recovery exercises remain opt-in tooling outside mandatory PR gates.

## Isolation and coverage enforcement

[scripts/ci/safety.mjs](../scripts/ci/safety.mjs) refuses a missing test URL, non-loopback service, database outside `soundwave_ci_*`, connection URL overrides, ambient application database/Redis/SMTP settings, `.env`, unsupported Node, missing CI namespace or missing backup container for the full test gate. A clean checkout is required. CI service passwords are public, disposable test values, not external secrets. Each job gets fresh service containers with loopback-only published ports; database tests create/drop generated schemas/databases and Redis tests use generated namespaces. PostgreSQL backup tooling runs inside the matching service container via `job.services.postgres.id`.

The [runner](../scripts/ci/run.mjs) executes existing npm test/build scripts and verifies successful TAP results for PostgreSQL migrations/import, transaction rollback/stale writes, playlist ownership/capacity races, profile/settings concurrent writes, distributed Redis limits and populated 21-table backup/restore. Missing optional integration environment cannot silently produce a green SQLite-only CI result. New tests can increase the count without updating a hardcoded expected total; required integration labels must be maintained deliberately if renamed.

Browser playlist and settings tests use a generated PostgreSQL schema; auth/offline/restart suites use temporary SQLite databases. Runtime application connection URLs are cleared for children, Google provider configuration/mail delivery/live imports are disabled, and optional mail URLs must point to local capture. Existing application authentication tests still exercise the real verifier with signed local JWT/JWKS fixtures; no real Google account credentials are supplied to CI.

## Failure evidence and credential boundaries

Command stdout/stderr is line-buffered and sanitized into `artifacts/ci/logs`, with exit codes/timeouts/durations and a required-integration report. Failure steps upload **only `artifacts/ci/`**, exclude hidden files and retain evidence seven days. The optional job retains its bounded result/benchmark artifacts on success too. Cancellation stops superseded runs; timeouts terminate the command's process group so API/browser children cannot keep a gate alive indefinitely.

Browser failures capture a masked PNG plus a small allowlisted JSON snapshot: pathname (no query/fragment), online/service-worker flags and numeric media state. Inputs, textareas and account panels are masked. Raw HTML, DOM text dumps, browser profiles, cookies, storage state, HAR, traces, dotenv files and database backups are not uploaded. Logs redact service connection URLs, long hex secrets, JWTs and auth/password/token fields. These defenses supplement the main boundary: CI receives no developer/production secrets. They are not a guarantee that arbitrary future logging is safe; changes to logs/artifacts require review. Avoid `set -x`, dumping environments or widening upload paths.

## Local CI-equivalent reproduction

Use Node 22 and a **clean disposable export/checkout without `.env`**, never your normal working directory with application configuration. Use a new local `soundwave_ci_*` database, a dedicated Redis and matching PostgreSQL tooling. The role needs schema and generated-database create/drop privileges for tests; do not reuse a production role.

```bash
export CI=true
export TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/soundwave_ci_local
export TEST_REDIS_URL=redis://127.0.0.1:6379
export REDIS_PREFIX=ci-local
export TEST_BACKUP_CONTAINER=YOUR_MATCHING_LOCAL_POSTGRES_CONTAINER
node scripts/ci/run.mjs install
node scripts/ci/run.mjs test
node scripts/ci/run.mjs build
node scripts/ci/run.mjs format
# Linux CI installs dependencies; macOS may use installed Chrome instead.
node scripts/ci/run.mjs browsers
node scripts/ci/run.mjs browser
```

For optional checks, additionally set loopback `TEST_SMTP_URL` and `TEST_MAILPIT_URL`, then run `node scripts/ci/run.mjs extended`. The runner validates isolation before invoking commands. Do not set `DATABASE_URL`, `REDIS_URL` or `SMTP_URL` on the runner; the explicitly named test variables select disposable services. Existing macOS Chrome is an allowed local fallback; CI installs Playwright Chromium explicitly.

Workflow syntax can be checked with `actionlint .github/workflows/ci.yml`; this task used upstream actionlint v1.7.7. YAML/actionlint validation does not execute hosted-runner provisioning, action download/cache behavior, GitHub artifact uploads or branch protection. Those remain unverified until an approved push/PR and real run.

## Actual local execution

| Check                                             | Result                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean Node 22 `npm ci`, migrations, build, format | PASS from a disposable export using the exact runner modes                                                                                               |
| Application backend/frontend suite                | **178 passed** (141 + 37), 0 failed/skipped                                                                                                              |
| CI isolation/redaction safety tests               | **6 passed**                                                                                                                                             |
| Mandatory browser gate                            | **35 passed**: login 5, PG playlists/playback 10, offline 13, restart 7; freshly installed managed Chromium                                              |
| Additional core browser regression                | **14 passed** after correcting its async waits                                                                                                           |
| Optional local systems checks                     | **7 systems + 4 worker restart + 5 supervisor checks passed**; synthetic HTTP run completed 4,000 consistent responses with zero errors                  |
| Workflow validation                               | actionlint v1.7.7 PASS; no actual hosted execution                                                                                                       |
| Failure evidence checks                           | Real deliberately failed migration propagated a nonzero exit and retained sanitized logs; screenshot/allowlisted JSON probe passed with fake credentials |

These executions used macOS/Apple Silicon, a new disposable database on the existing dedicated PostgreSQL test server, new Redis/Mailpit containers and mac-arm64 Chromium. They do not prove Ubuntu provisioning or GitHub uploads. Optional benchmark results are local synthetic diagnostics, not production capacity evidence. Logs, durations, coverage guards and hashes are in [ci-verification.json](ci-verification.json). No application source/schema/dependencies changed.

## Documentation inventory reconciliation

M1.2's immutable range is **`286dd90..33d07ec`**: five implementation/test commits plus the final documentation commit `33d07ec`, **six total**. The original evidence JSON was generated before its own commit and therefore listed only the five implementation commits. Its reconciliation now records the documentation commit separately and the complete fixed range; later M6.1 commits do not belong in that M1 inventory.

References: [GitHub PostgreSQL service containers](https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services/creating-postgresql-service-containers), [official setup-node](https://github.com/actions/setup-node), [artifact upload options](https://github.com/actions/upload-artifact). These document platform behavior; they are not proof this repository has a successful remote run.

## M1.1 regression additions

The Settings browser script now joins the mandatory bounded browser gate and the TAP guard requires PostgreSQL account-settings concurrency/rollback coverage. Current application counts and the local M1.1 verification are recorded in [M1_SETTINGS.md](M1_SETTINGS.md); the original M6.1 counts above remain historical evidence. Remote Actions status remains NOT RUN.

## M1.3 regression additions

The mandatory browser runner also executes `scripts/queue-smoke.mjs` against generated PostgreSQL schemas. This covers queue editing, account clearing, refresh, real cross-story transitions and downloaded playback; it has the existing three-minute script deadline and masked failure artifacts. Local evidence and limitations are recorded in [M1_QUEUE.md](M1_QUEUE.md). Remote Actions remains NOT RUN.

## M1.5 concurrency gate additions

The TAP guard requires PostgreSQL cross-device CAS, valid rejected-attempt identity protection, populated revision migration and real Redis-client disconnect/reconnect coverage. The mandatory browser job also runs two independently authenticated contexts through `cross-device-smoke.mjs` against PostgreSQL/Redis. Backend test files use concurrency four to bound local resource use; race tests retain their simultaneous operations. New protocol documentation/evidence is explicitly formatted. [Contract and actual results](M1_CROSS_DEVICE_SYNC.md). Remote Actions remains NOT RUN.

## M1.4 history regression additions

The mandatory runner now requires successful PostgreSQL populated history migration, concurrent removal/update and guarded bulk-clear tests, with zero skipped backend tests. `history-smoke.mjs` joins the same bounded browser gate and masked failure artifact handling, using a generated PostgreSQL schema. SQLite is checked locally too. No extra infrastructure or secrets are needed. [Exact current local results](m1-history-verification.json); hosted Actions remains NOT RUN.

## M2.1 creator identity gates

The mandatory integration guard requires PostgreSQL active-role/ownership checks, concurrent onboarding/suspension and rollback, populated creator migration, Google/password identity preservation, provider protection and SQLite import conflict preservation. Full backup/restore now verifies 22 tables, including creator profile/status and staff/story ownership columns. `creator-smoke.mjs` joins the bounded mandatory browser job with generated PostgreSQL schemas; SQLite is also checked locally. No new services/secrets are required. [Current local evidence](m2-creator-identity-verification.json); remote Actions remains NOT RUN.
