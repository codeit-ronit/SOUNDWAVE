# M3/M4 targeted hardening

Local verification: **485 application tests (325 backend + 160 frontend), 6 CI safety tests, 121 browser groups, 7 Docker checks and 5 coordinated-restore checks passed**, plus clean installation/build/format. Measurements are recorded in `m3-m4-verification.json` and `m3-m4-benchmarks.json`. No deployment or remote GitHub Actions execution. This checkpoint targets the existing product’s integration boundaries; broader roadmap features such as account export, OpenAPI and global catalog pagination are not silently marked complete.

## Security and transaction boundaries

Publication now uses **prepare → verify → commit**. A short owner/actor-locked transaction authenticates and captures current revisions, exact source/head/output identities and storage keys. Streaming SHA-256 verification happens outside SQL locks, with four concurrent verifications per adapter/process, bounded bytes, a 30-second streaming deadline and retained descriptors. The commit transaction repeats authorization, receipt/revision checks and the complete metadata/storage-key comparison, then compares descriptor and current-path inode/device/size/mtime/ctime before changing state. Replay/error precedence is preserved. A concurrent revoke wins; a stale verification cannot publish. HTTP publication commits revalidate the session after hashing, so completed logout/expiry before that check prevents the write. A request already past the final authorization check is not retroactively cancelled.

The pre-optimization measurement used actual processed eight-minute audio. A separate explicitly injected 40 ms storage-open workload tests slow storage, not a claimed production workload. The benchmark synchronizes the competing owner transaction at the storage hook and measures its own COMMIT; an early draft incorrectly included publication completion and was discarded. Final matched runs are sequential against commit `72fd5eb` and current source, with the same driver and disposable services. Exact distributions and tradeoffs are in the benchmark artifact; lower contention does **not** imply lower end-to-end publish latency.

A reproduced gap allowed same-size on-disk corruption to stream after approval. Public/review MP3 streams now hash opened output on an integrity-cache miss. The bounded process-local cache holds at most 128 signatures for 30 seconds, bound to output/checksum/device/inode/size/nanosecond mtime/ctime. Every request obtains fresh file identity and still checks current SQL publication authorization; the cache grants no access. Streams use explicit offsets after hashing. HTTP 200/206/416 and HEAD remain supported.

**Filesystem assumption:** application writers create unique keys and never mutate ready objects. Private directory/file permissions remain enforced. Stat/inode checks detect tested replacement and in-place rewrites, including restored mtime. They do not defeat a privileged process changing bytes after the final check or manipulating the filesystem/kernel. SQL and filesystem operations are not atomic. Metadata opens/stats still occur during final commit, so slow/hung filesystem metadata can hold locks; kernel I/O hangs and hostile root writers are not verified. Do not describe keys alone as immutable-byte proof.

## Observability

No new telemetry dependency or monitoring service. Fixed-name, fixed-enum histograms/counters track HTTP duration/errors/aborts, DB query/transaction wall time, publication prepare/verify/commit/revoke, outbox job duration/failures and processing duration/retries/failures. Logs replace raw request paths with bounded categories. No user IDs, emails, cookies, CSRF tokens, media keys, raw SQL or arbitrary paths are metric labels.

`GET /api/internal/diagnostics` requires an authenticated **admin**, rejects selectors, and uses `private, no-store`. It reports process-local histograms, pool total/idle/waiting, cache hits/misses, grouped backlog count/age/attempts, reservation/quota/orphan bytes and cleanup errors. Worker-local metrics/resources are written to the existing protected worker heartbeat JSON; they are not magically aggregated into the API process. Use operator Docker access to inspect that file. Existing `HTTP_LOG=1` produces structured request logs.

`npm run ops:diagnostics` needs an explicit `DATABASE_URL`, loads no dotenv and performs reads only. Use this during Redis outages when HTTP private-operation throttling intentionally fails closed. CLI reads another process’s database backlog, **not** its in-memory histograms. Metrics reset on restart; external collection, durable retention and distributed traces remain follow-up work.

## Recovery and deployment controls

`RELEASE_QUARANTINED=true` blocks application/legacy media traffic and makes readiness fail until recovery is explicitly completed. Defaults false; operators must set it before restoring/starting a recovered service. Compose explicitly propagates the flag, and the worker refuses startup before opening database/Redis connections while quarantined. Startup refuses unknown future schema versions; this cannot retroactively fence already-running old binaries. Drain API, worker, scheduler, seed/import and operator writers and revoke obsolete database credentials as part of rollout.

Operator-only commands, with explicit configuration and no dotenv:

```sh
RELEASE_QUARANTINED=true npm run ops:takedowns -- export /protected/latest-takedowns.json --confirm-operator
RELEASE_QUARANTINED=true npm run ops:takedowns -- reconcile /protected/latest-takedowns.json --confirm-operator
```

Set `DATABASE_URL` securely in the process environment; never commit or print it. Export creates an exclusive mode-0600 ledger of currently non-public publication revision fences, capped at 10,000 entries. Reconciliation is transactional, advances revisions monotonically, preserves listener data and writes operator audit records. Reapplying the same ledger is harmless. The ledger is trusted operator input, not cryptographically signed; freeze the authoritative source or reconcile subsequent changes before reopening. An old ledger cannot prove there were no later takedowns.

The real restore drill creates a PostgreSQL archive plus matching private files, restores into a new database/root, verifies WAV/MP3 checksums under quarantine, applies a takedown issued after backup, and proves public catalog/ranges remain blocked after controlled reopening. Ordinary DB backup tests still verify all 32 table fingerprints. DB archives do not contain media. Neither this drill nor copying a live directory constitutes an atomic live database/volume backup.

API Compose resource limits are now 1 CPU/384 MiB; worker retains 1 CPU/512 MiB, FFmpeg limits, health checks and private shared volume. Redis retains AOF/noeviction/64 MiB. Worker OS dependencies are installed in a layer before application source, avoiding repeated FFmpeg installation on ordinary source changes; the first cold dependency build can still exceed the bounded drill timeout. Limits are local starting budgets, not capacity guarantees. Exact current Docker restart/recovery evidence is in the verification artifact.

## Reproduce and release gate

- Full local CI: `node scripts/ci/run.mjs install|test|build|format|browser` with `CI=true` and explicit disposable loopback `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_BACKUP_CONTAINER` as documented in CI setup.
- `npm run bench:hardening` uses a generated private fixture and bounded local workload. Optional `BENCH_STAGE` and `BENCH_OUTPUT` label/write evidence; comparing stages requires running the identical driver against the actual corresponding code revisions, sequentially.
- `npm run test:hardening:recovery` requires disposable PostgreSQL and matching Docker backup tooling. `npm run test:processing:systems` runs the existing real API/worker/Redis/named-volume Docker restart drill.
- Mandatory CI adds tampering, revocation-during-verification, diagnostics access and monotonic restore regressions; heavy Docker/restore/benchmark jobs remain optional. No noisy absolute latency threshold is imposed on shared GitHub runners.

Before final M6 release: review deployment secrets/TLS/CORS/proxy routing, restricted runtime DB credentials, fresh coordinated backups and takedown authority, encryption/offsite retention, monitoring collection/alerts and rollback/drain rehearsal. Public email, cross-browser behavior, larger populated-catalog pagination/load, long-run queue retention/global disk budgets and multi-host storage are not certified by this checkpoint. Previously downloaded/buffered audio cannot reliably be recalled.

## Measured local results

Eight publication cycles per storage scenario; p95/p99 with eight samples are maxima. HTTP workloads use 30 requests/concurrency 4; sequential progress/history writes preserve their revision protocol. These are small local measurements, not tail-latency guarantees.

| p95 milliseconds                       | Before | Hardened |
| -------------------------------------- | -----: | -------: |
| Owner wait, local storage              | 10.976 |    1.380 |
| Owner wait, injected 40 ms open        | 55.636 |    1.215 |
| Submit end-to-end, local               | 14.641 |   23.688 |
| Submit end-to-end, injected 40 ms open | 60.094 |  108.051 |

The complete artifact includes p50/p95/p99, true HTTP batch throughput/errors/cache ratios, CPU/RSS/pool snapshots and one actual eight-minute-audio processing job at concurrency 1. Publication timings are service/DB calls, not full HTTP/session round trips; rates are labelled inverse-mean-latency, not concurrent system throughput. Publish/revoke race outcomes differ: the hardened publisher often loses legitimately while verifying, so do not compare their aggregate publish p95 as success-only latency.
