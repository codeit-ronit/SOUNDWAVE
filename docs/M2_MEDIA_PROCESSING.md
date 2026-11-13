# M2.5 — durable private audio processing

Local milestone based on `b815ec5`: **446 application tests, 6 CI safety tests, 158 browser check groups and 6 Docker recovery checks passed**, plus clean install, builds and formatting. Nothing pushed/deployed; remote Actions NOT RUN. [Exact verification](m2-media-processing-verification.json). Source WAV validation remains distinct from derivative readiness. No publishing, rights approval or moderation is implemented.

## Flow and schema

Upload completion commits a `private_processing_intents` row and an existing `background_jobs` outbox event in the **same transaction**. Additive PostgreSQL **017_private_processing.sql** / SQLite **018_private_processing.sql** add intents, immutable attempt outputs, owner/asset binding and recovery/cleanup indexes. They backfill previously validated current draft WAVs as **pending**, never ready; migrated work is immediately due. Backups now fingerprint 28 tables. Existing listener data, WAV assets, chapter metadata and their revisions are preserved.

The outbox keeps its existing constrained kinds: an additive `dispatch_topic=private_audio` explicitly types a maintenance dispatch envelope, with owner and intent ID. This avoids rebuilding SQLite's existing job table. The existing worker claims/acks/fails these events, dispatching into a dedicated BullMQ queue. Ordinary maintenance/email/analytics behavior remains unchanged. With private processing disabled (`MEDIA_JOBS=false` or no Redis), private dispatch events stay pending.

Canonical database identity is exactly `private-audio:{assetUUID}:{sha256}:processor-v1`. BullMQ forbids colons in custom IDs, so the transport ID is SHA-256 of this identity plus the controlled retry generation. Neither the broker nor a client supplies source paths, checksums as proof, or ready status. Database intent/current head is the recovery authority.

| Intent state | Meaning                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| pending      | Durable work waiting for dispatch/backoff; no ready derivative                                               |
| processing   | Owner-locked admission, unique fence/lease and quota reservation; real hashing/transcoding/validating stages |
| ready        | Verified private MP3 metadata/output committed atomically after final eligibility/fence checks               |
| failed       | Visible permanent/exhausted/ineligible work; eligible owner may explicitly retry                             |
| superseded   | Source/head changed, deleted or chapter/story retired; work cannot restore it                                |

Output rows separately track writing/ready/orphan/deleted, unique opaque keys, fence, reserved/actual bytes, SHA-256, MP3 format, decoded duration, sample rate/channels and timestamps. A partial unique index permits one ready output per intent. No object is overwritten; every attempt registers its key **before** filesystem creation. Originals are retained unless explicitly removed/replaced/archived by the existing lifecycle.

## Fences, retries and recovery

All intent/output mutations serialize on the existing account lock. Before work and commit, the worker checks exact asset/story/chapter ownership, active registered creator, current validated source/head and revisions, source hash and processor version. Chapter edits during an attempt invalidate that attempt; an already completed derivative still represents the same immutable audio despite later title changes. Conversion holds no SQL transaction. Only the matching unexpired processing fence may commit; stale workers cannot change a newer result or delete another attempt's key.

There are four automatic attempts per generation, persisted attempts/failures and exponential 1/2/4-second backoff (bounded at 60 seconds). Permanent source/validation/dependency failures are visible without requiring broker state. Explicit retry requires the latest intent revision and eligible current source; at most ten generations/40 attempts per asset. Ready output can be rebuilt only when the server verifies its file is missing/corrupt; intact ready output is rejected as already ready. A repeated stale retry conflicts, rather than consuming another generation silently.

A five-second recovery loop fairly checks bounded 50-row batches using persisted reconciliation timestamps, repairs absent/dead/acknowledged outbox events and reclaims expired leases. Redis queue loss after dispatch acknowledgement cannot lose pending database work; completed/failed transport jobs may be removed/re-enqueued while SQL still requires work. Replays of committed work are no-ops. Dispatcher retries can continue through a broker outage; encoding retries remain bounded. The existing configured Redis policy still fails private HTTP operations closed during an outage; it is not a promise that private APIs work without Redis.

Leases last `3 × PROCESSING_TIMEOUT_SECONDS + 45s`; no heartbeat can let a stalled process hold admission forever. Expired attempts receive new fences/keys. Original and derivative quota includes physically unreleased attempt files. Replaced/deleted/failed outputs remain charged until confirmed removal; source cleanup waits for an active processing lease. A separate attempt cleanup pass deletes only registered orphan keys, checks cross-table key ambiguity, and never touches a newer ready result. Cleanup failures stay visible/charged and are retried. No directory-wide deletion or user-selected paths are used.

Normal shutdown aborts and kills subprocess groups before releasing output leases. Abrupt death leaves tracked files/lease state for recovery. Tests kill actual Node handlers during partial output, after write and after commit; expired persisted deadlines are fault-injected to accelerate takeover, rather than sleeping through production leases. The Docker drill separately kills the real worker and restarts volatile Redis/API on an isolated volume. Host clocks must be synchronized for lease/deadline scheduling; token fencing still rejects a stale commit after takeover.

## FFmpeg and resource contract

Install FFmpeg/ffprobe with `libmp3lame` (`brew install ffmpeg` on the tested Mac; Ubuntu: `sudo apt-get install ffmpeg procps util-linux`). The Docker **worker** installs these binaries; the API image does not transcode. Start the existing `npm run worker` with the same PostgreSQL/Redis/private-volume configuration as the API.

The processor opens checked private descriptors, hashes the complete source and the exact bytes fed into FFmpeg, then converts fixed PCM WAV input to stereo 44.1 kHz, 96 kb/s MP3. Spawn uses argument arrays, fixed pipe/descriptor inputs and no shell interpolation. It strips source metadata/video. ffprobe verifies the generated stream; a bounded full decode measures duration and checks it against the source. Size/SHA-256 are rechecked before commit. No complete media file or decoded PCM is held in process memory.

| Limit                        | Default / enforcement                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `PROCESSING_TIMEOUT_SECONDS` | 20, max 60; each subprocess wall timer and process-group kill                                    |
| `DERIVATIVE_MAX_BYTES`       | 8 MiB, max 16 MiB; reserved transactionally and enforced on streaming output                     |
| `PROCESSING_MEMORY_BYTES`    | 256 MiB, max 512 MiB; 100 ms RSS watchdog; Linux also uses prlimit CPU/address-space guards      |
| CPU/concurrency              | One private BullMQ job per worker, encoder/decoder threads limited; Compose worker 1 CPU/512 MiB |
| Auxiliary output             | stderr 64 KiB, probe JSON 16 KiB, decoded PCM bounded by source duration + 2 seconds             |

macOS RSS monitoring is not a strict instantaneous OS memory ceiling. Linux address-space limit is at least 1 GiB (or four times the RSS setting) to permit shared-library mappings; the tested Docker worker also has a hard 512 MiB container limit. No load/capacity or byte-identical output across FFmpeg versions is claimed. Installed binary versions are recorded in verification; pin/review encoders and bump the processor contract for semantic changes. Large valid inputs may exceed time/output/quota limits and fail visibly.

## Private API and Studio

Existing media base: `/api/creator/stories/:story/chapters/:chapter/media`.

- GET base adds `processingIntent` and `derivative` summaries, never internal keys/leases/paths.
- GET `/:asset/processing` reads owned status/attempts/stage/error and ready metadata.
- POST `/:asset/processing/retry` takes only `{expectedRevision}` and reuses session/CSRF/origin protection.
- GET/HEAD `/:asset/derivative` serves only eligible current ready MP3, with private/no-store, fixed audio MIME/name and existing single-range 200/206/416 semantics.

All routes require an active registered exact owner, including staff. Source WAV preview remains. Public catalog/audio/legacy aliases/offline downloads cannot access creator drafts. Ready means technically processed, **not published**. Studio shows actual stage/attempts, manual Refresh/Retry, native authenticated MP3 preview and recoverable storage errors; it supplies no fake processing percentages or WebSockets. Account switching retires private requests/previews. Original shared listener-player controls remain unchanged.

## Import, backup and operations

Database-only SQLite import preserves processing/output metadata but marks imported intents failed (`RESTORE_BYTES_REQUIRED`), clears dispatch leases/outbox references, and retires unavailable outputs with new opaque keys. Existing target private collections/results win. It never claims copied metadata implies available bytes or queues stale imported processing. A new upload produces a new legitimate intent.

Database archives do not contain source/derivative files. Stop writers and restore a matching private-volume snapshot with the database. `npm run media:private -- verify --confirm-operator` now checks both validated sources and ready derivatives; cleanup also reconciles processing/orphans. These require explicit database/root settings and load no dotenv. Full live DB/filesystem atomic backup, S3/multi-host storage, power-loss/kernel-hang tests and cross-browser compatibility remain unverified.

Verification commands: full strict `node scripts/ci/run.mjs test|build|format|browser` with disposable test services; `npm run test:processing:browser` with loopback `TEST_REDIS_URL` and optional disposable `TEST_DATABASE_URL`; `npm run test:processing:systems` for isolated Docker builds/restarts. Mandatory CI installs FFmpeg and checks real PostgreSQL processing/recovery labels. The heavier Docker drill is optional CI tooling and was run locally. No remote Actions success is implied.

## M2.6 boundary

The pipeline supplies immutable checked source/output identities and fenced technical readiness. Publishing still needs explicit rights/license attestations, review/publish transitions, creator/admin permissions, revision-checked eligibility, public catalog/search/cache invalidation, authenticated/private versus public storage rules, unpublish/revocation/offline policy and end-to-end visibility/rollback tests. Do not expose the current private keys/routes or treat `ready` alone as publication authority.
