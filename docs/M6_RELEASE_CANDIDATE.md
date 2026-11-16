# M6-A release candidate

Baseline `63a8e53`, branch `feature/m1-private-playlists`. Local preparation only: **no push, PR, tag, deployment, DNS or cloud provisioning**. Machine-readable results: [verification](m6-release-verification.json), [release stack](m6-release-stack.json). Hosting assumptions and costs: [free-tier plan](DEPLOYMENT_FREE_TIER.md).

## Blockers and decisions

| Priority    | Finding                                                                                                      | Disposition                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0          | Every PostgreSQL API/worker startup migrated and seeded; runtime needed DDL and could rewrite seeded catalog | Fixed: production PostgreSQL defaults to `DATABASE_INIT=verify`, checks exact migration checksums/versions read-only, never seeds. Explicit operator migrate/seed remains available. Restricted runtime regression tested |
| P0          | Development Compose publishes local dependency ports and lacks production TLS / separate DB roles            | Added standalone release profile, Caddy, private networks/volumes, distinct operator bootstrap and runtime credentials; development setup unchanged                                                                       |
| P0          | Dynamic edge API allocation could occupy the proxy's reserved IP                                             | Reproduced during smoke; fixed API `.3` and proxy `.2`, with exact trusted proxy CIDR                                                                                                                                     |
| P0 external | Approved public host, free capacity/price, DNS/ACME, actual Google origin, remote Actions                    | Not verified; requires M6-B approval and owner account access                                                                                                                                                             |
| P0 release  | Historical root Vercel routing points to older backend                                                       | Preserved existing live setup. Review/disable Git autodeploy before any future push; do not promote this config unchanged                                                                                                 |
| P1          | Global disk budget, offsite encryption/retention, monitoring alerts, VM loss/idle reclamation                | Documented operator constraints; no claim of high availability or full operational automation                                                                                                                             |
| P1          | Existing populated-database ownership adoption / incompatible binary rollback                                | Fresh bootstrap verified only. Rehearse reviewed restore/ownership transfer on disposable data before migrating an existing deployment                                                                                    |
| P2          | Optional split frontend, multi-host storage, external telemetry                                              | Deferred; single-origin modular monolith preserves current session/offline contracts                                                                                                                                      |

No schema changes were needed. PostgreSQL has 18 migrations, SQLite 19; production SQLite compatibility remains an explicitly limited local/demo path, not the release target. Runtime can perform application DML but cannot CREATE/ALTER/TEMP or change migration records. These DB credentials do not replace application ownership authorization, and are not per-user database roles.

`server/operations/release-roles.js` refuses existing roles and nonempty public databases, rolls back failure, and never rotates existing credentials implicitly. Runtime gets default DML and sequence usage for migrator-created tables. New migrations must review grants for any new operator-only tables. Bootstrap needs a trusted administrator; HTTP routes never import it.

## Initial deployment procedure — NOT EXECUTED; approval required

Use only an approved empty release database. Never repoint these commands at a developer/production database or discard existing data. First complete the cost, domain, firewall and backup decisions in the free-tier plan.

1. Provision only after approval. Install Docker/Compose and check `docker info --format '{{.Architecture}}'` is `aarch64`/`arm64`. Keep SSH restricted and application ingress closed.
2. Protect `/etc/soundwave`, copy the example configuration there and fill independent random secrets without shell history/logging. Set the real HTTPS origin and keep quarantine true. The following commands run from this repository and use **only** `compose.release.yaml`, never the development overlay:

   ```sh
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml config --quiet
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml build app worker
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml up -d --wait postgres redis
   ```

3. Temporarily set the protected `migrator.env` to the administrator's internal PostgreSQL URL plus `MIGRATOR_PASSWORD` and `RUNTIME_PASSWORD`. Run the explicit bootstrap below; it creates `soundwave_migrator` and `soundwave_runtime` in the empty database. Then **replace** that file with the migrator-only URL and APP_ORIGIN, remove bootstrap secrets, and set runtime.env to the distinct runtime URL. Administrator credentials must never enter API/worker configuration.

   ```sh
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml --profile ops run --rm migrate node server/scripts/release-roles.js --confirm-operator
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml --profile ops run --rm migrate
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml up -d app worker
   ```

4. While quarantined, readiness must fail and the worker must refuse startup. Inspect only protected logs. Confirm the expected DB migration fingerprints, persistent private volume and administrator-only dependency access. A quarantined worker exiting is expected, not a healthy release. Do not bypass verification with runtime `DATABASE_INIT=migrate`.
5. After migration/recovery review and **explicit authorization to expose content**, set quarantine false, recreate API/worker and wait for health. Validate Caddy configuration, then open approved 80/443 ingress and start the proxy for public ACME issuance:

   ```sh
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml up -d --force-recreate --wait app worker
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml run --rm --no-deps proxy caddy validate --config /etc/caddy/Caddyfile
   docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml up -d proxy
   ```

6. Verify real public HTTPS/renewal storage, `/api/ready`, SPA deep links, guest isolation, Google/email login as configured, CSRF/cookie flags, private draft 404s, uploads, worker completion, moderation/publication, 200/206/416/HEAD, ordinary playback without 429, offline download/range/removal and revocation. Check dependency ports externally are closed. Record URL/results before calling it deployed.

Use protected operator access to grant a registered account moderator privileges, never a public role-grant endpoint:

```sh
docker compose --env-file /etc/soundwave/release.env -f compose.release.yaml --profile ops run --rm -e DATABASE_INIT=verify migrate node server/scripts/creator.js role USER_UUID moderator --confirm-operator
```

## Backups, rollout and recovery

Reuse [operations backup tooling](OPERATIONS.md#postgresql-backup-and-restore-drills) and [M3/M4 quarantine/takedown procedure](M3_M4_HARDENING.md#recovery-and-deployment-controls). No restore over a real database was attempted here.

Before any incompatible rollout, stop/drain **all** API, worker, import, seed, scheduler and operator writers. Export a fresh protected takedown ledger; create a matching PostgreSQL archive/manifest and private-volume snapshot while writes remain frozen. Check all 32 tables and source/output bytes in a disposable restore. DB-only backups do not contain audio. Encrypt and copy backups off the VM; retain keys separately. The earlier seven Docker and five coordinated-restore checks are historical M3 evidence, not M6 reruns.

Rotate/revoke obsolete service credentials and terminate obsolete connections before promoting a new binary. Do not merely change the password file: PostgreSQL keeps active sessions and initial container passwords are not reapplied to existing volumes. Perform role changes through a trusted operator; the bootstrap intentionally refuses rotation. Retain protected rollback configuration/images and backups, never credentials in Git.

For a failed deployment: close ingress, set quarantine, stop writers, inspect protected logs and schema versions. Roll back binaries only if their schema contract is compatible. Never force an old binary past migration verification or run destructive down migrations. For an incompatible schema, recover the matched DB/files into an isolated target, reconcile the latest takedowns and subsequent session/role/suspension/email changes, and repeat disposable checks before cutover. A pre-backup identity/ledger snapshot is insufficient proof of current authorization. Fresh-data-loss/RPO decisions require the owner; do not silently overwrite newer user data.

## Verification and demo

| M6-A check actually executed                             | Result                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Clean export / locked `npm ci`                           | PASS; 341 packages installed, zero reported dependency vulnerabilities                           |
| Full application suite                                   | PASS: 327 backend + 160 frontend = **487**, zero failed/skipped                                  |
| CI safety tests / required PostgreSQL integration labels | PASS: 6 tests; no missing evidence, no skipped backend cases                                     |
| Mandatory browser gate                                   | PASS: **110 groups in 13 scripts**, including restart, progress, creator publication and offline |
| Standalone Docker / TLS release workflow                 | PASS: **7 groups**, five native ARM64 images; disposable project removed                         |
| Final focused role regression                            | PASS: 2 cases rerun, including denied TEMP/DDL and migration-ledger writes                       |
| Formatting (repository + CI/release documents/config)    | PASS                                                                                             |
| Frontend production build                                | PASS                                                                                             |
| Remote Actions / public deployment                       | **NOT RUN / NOT VERIFIED**                                                                       |

Final local counts and commands are recorded in `m6-release-verification.json`. The mandatory CI runner now requires the actual PostgreSQL restricted-role test to appear as passing, preventing a skipped integration suite. PR/push jobs retain Node 22, PostgreSQL 18.6, Redis 7.4, FFmpeg, minimal read permissions, SHA-pinned actions and sanitized failure artifacts. Optional systems checks add the release-stack script; they are not mandatory PR benchmark gates. Branch protection is an external repository setting, not configured by this workflow. Remote GitHub Actions remains **NOT RUN**.

`node scripts/release-smoke.mjs /private/tmp/release-proof.json` creates its own random project, credentials, database, volumes and loopback TLS port and removes them in `finally`. It builds the native API/worker and inspects all five architectures. Its browser trusts only the disposable Caddy leaf's SPKI for the test ([Chromium switch](https://chromium.googlesource.com/chromium/src/+/d66160822607fe290bed888dc511a8664f11d9e1/content/public/common/content_switches.cc)); it does not ignore global TLS validation or alter the host trust store. Native image probes additionally loaded SQLite 3.53.2 in memory and ran FFmpeg 5.1.9 on Node 22.23.5/arm64; both API and worker ran as UID 1000 with no network or host mounts. ARM evidence is native local Docker, not an Oracle deployment. AMD64 GitHub execution remains pending.

Demo sequence: register → activate Creator Studio → create story/chapter → upload a short PCM WAV → observe FFmpeg completion → submit with rights declaration → moderator approve exact revision → creator publish → another listener searches/plays/seeks/downloads → revoke → confirm new public reads fail. Existing offline copies cannot be recalled. A real external mail sender, public Google at the new origin, cross-browser behavior, sustained capacity, offsite restore and public uptime remain unverified.

Historical performance is preserved in [M3/M4 results](M3_M4_HARDENING.md#measured-local-results), not rerun or presented as new evidence. In its eight-cycle injected-storage experiment, owner wait p95 changed 55.636→1.215 ms while submit latency increased 60.094→108.051 ms; this is a small local contention measurement, not production throughput.

## M6-B approval boundary

Nothing below has been executed. First review/disable existing Vercel Git auto-deploy and inspect the candidate. With explicit permission, push the feature branch (`git push -u origin feature/m1-private-playlists`), then obtain approval to open a PR and run/check actual Actions. Provisioning, DNS, security lists, credentials, migration/promotion and any public URL change require separate explicit approval. No tag, merge, force-push or billing upgrade is prepared as an automatic step. Public smoke evidence is required before updating resume/demo links.
