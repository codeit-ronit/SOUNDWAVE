# M1.5 — cross-device progress consistency contract

Implemented locally on `feature/m1-private-playlists`, from checkpoint `f13fbcf`. The initial contract was written before code changes; this report now records final behavior and verification. No deployment was performed.

Implementation commits: `f585e63` (schema/import/backup) and `b86b9ec` (end-to-end protocol/player/tests). CI and final verification documentation are committed separately.

## Previous behavior

`listening_progress` stored owner/chapter position, completion and timestamp. `progress_write_versions` kept a per-browser client UUID and highest sequence. PostgreSQL `lockProgress` took a transaction advisory lock for owner/chapter; SQLite serialized transactions. Duplicate/older sequences from one client were ignored, but independent client IDs had no shared precondition: the last processed write could replace another device's position or completion. Unversioned writes bypassed the sequence guard. Position was not a maximum: intentional backward seeks already worked. A false-to-true completion transition emitted a completion event transactionally; ordinary wall-clock listening events were separate.

## New consistency contract

- Every owner/chapter state has a monotonic server revision, starting at 0 (also for migrated data and an absent row). Each state-changing update and every explicit reset increments it once, including intentional rewinds. An equivalent-state ordinary update at the current revision is acknowledged without another increment. The first accepted write creates a row at revision 1, even for position zero. Position is never merged with `max`.
- PUT requires `expectedRevision`, `clientId` and positive `sequence`. The owner is exclusively the authenticated session. Missing preconditions are 428; old clients cannot write around concurrency checks. Read APIs remain compatible; deploy backend and new frontend together, retain progress data, and require old/offline application shells to refresh before synchronization.
- Within the existing owner/chapter transaction lock, a write is accepted only against the current revision. A stale precondition returns 409 `PROGRESS_CONFLICT` plus current server state. Two concurrent devices using the same revision cannot both win.
- Identity is owner/chapter/client UUID/sequence. The existing version row stores that client's last canonical request hash and acknowledgement/rejection. Retrying that latest identity with the identical payload is an acknowledgement, not a new mutation/event. A changed payload is 409 `PROGRESS_IDENTITY_REUSED`; an older sequence is 409 `PROGRESS_WRITE_RETIRED`. Receipt responses include the accepted revision and current state, so acknowledging an old success cannot disguise a newer remote write.
- Validation/admission failures (400/401/403/428/429) do not reserve an identity. Valid transactional conflicts do reserve it: a repeated identical rejected attempt stays rejected, and changing its payload is identity reuse. Decisions generate a new sequence.
- Metadata stores one latest receipt/high-water mark per client/chapter, at most 32 newly admitted client slots, including rejected valid attempts. Historical pre-migration slots are preserved; when the cap is reached existing clients continue, and new ones receive a bounded-capacity error. Older receipts are retired rather than replayed as new writes. No unbounded request/event payloads or new receipt table.
- `action:"update"` (default) permits arbitrary valid forward/backward position while incomplete; reaching the end marks complete. A completed state cannot become incomplete through an ordinary save. `action:"reset"` explicitly reopens it at a chosen position below the end. Reset does not erase analytics; a later false-to-true completion remains a real completion transition, while duplicate retries never add effects.
- Active local playback is never seeked/autoplayed merely because a refresh returned. A newer remote revision that would replace active/unsaved state needs **Resume Latest** (apply paused) or **Keep My Position** (one explicit conditional write against the displayed server revision). If that revision changed again the user sees a new conflict, without blind retry. Clean paused state may adopt a foreground refresh paused.
- Synchronization runs at initial authenticated load, explicit Refresh Progress, foreground visibility and connectivity restoration, with abort/session/occurrence guards and bounded requests. There is no continuous playback polling. Both devices may keep playing, but the first accepted writer advances the revision; the other must resolve its conflict before subsequent writes.
- Offline audio and the tab-local queue remain available. There is no durable offline write/event queue. Unsaved state is labeled; reconnection reads accepted server state and requires a decision when needed. A lost acknowledgement is retried with exactly its original identity/payload, not regenerated. Queue persistence remains local; no server-side queue synchronization.

## REST contract

All paths start with `/api`, require the existing owner session (registered or isolated guest), return private/no-store JSON and reuse the existing rate limits. PUT also requires CSRF/Origin validation. Query selectors and unknown body fields are rejected; an owner ID is never accepted. Chapter reads remain public catalog reads with owner-specific progress only when a session exists.

| Method/path                 | Contract                                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/progress/:chapterId`  | `{progress:{chapter_id,position_seconds,completed,revision,updated_at}}`; absent owner/chapter progress is position 0, incomplete, revision 0, timestamp null. Invalid/missing chapters are 400/404.                                                                                                  |
| GET `/progress`             | Existing history/Continue Listening response; progress rows additionally include revision.                                                                                                                                                                                                            |
| GET `/stories/:id/chapters` | Existing chapter fields plus current owner's revision (0 for no progress).                                                                                                                                                                                                                            |
| PUT `/progress/:chapterId`  | `{positionSeconds,completed?,clientId,sequence,expectedRevision,action?}`; position finite within duration, completion boolean, client UUID, positive safe-integer sequence, nonnegative safe-integer revision, action `update` or `reset`. Completion at the end retains existing normalization.     |
| PUT success (200)           | `{progress:<current state>,acknowledgedRevision,replayed}`. Exact receipt retry returns the current server state and the original accepted revision. A newer current state is not concealed by an old acknowledgement.                                                                                |
| PUT conflict (409)          | `{error:{code,message},progress:<current state>}`. Codes: `PROGRESS_CONFLICT`, `PROGRESS_RESET_REQUIRED`, `PROGRESS_IDENTITY_REUSED`, `PROGRESS_WRITE_RETIRED`, `PROGRESS_REVISION_LIMIT`.                                                                                                            |
| PUT admission/validation    | Missing preconditions: 428 `PROGRESS_PRECONDITION_REQUIRED`; invalid fields: 400; unauthenticated/CSRF: existing 401/403; stale account header: existing 409 without a progress disclosure; client-slot cap: 429 `PROGRESS_CLIENT_LIMIT`; configured Redis unavailable: existing protected-route 503. |

Example ordinary rewind, after reading revision 4:

```json
{
  "positionSeconds": 7,
  "completed": false,
  "expectedRevision": 4,
  "clientId": "10000000-0000-4000-8000-000000000001",
  "sequence": 17,
  "action": "update"
}
```

An explicit replay uses `action:"reset"`, `completed:false`, a position below the end, a newly allocated sequence and the revision the user chose to replace. It does not delete history/analytics. Same-identity payload checks use a canonical hash of the requested position/completion/revision/action, including values that normalize to the same final position. Body key order and omitted default fields do not create false differences.

## Database, transactions and retention

Four additive migration files, no new tables:

- PostgreSQL `011_progress_revisions.sql`, `012_progress_attempt_receipts.sql`.
- SQLite `012_progress_revisions.sql`, `013_progress_attempt_receipts.sql`.

`listening_progress.revision` is a bounded safe integer initialized to zero on retained rows. `progress_write_versions` gains `request_hash`, `accepted_revision`, `ack_position`, `ack_completed`, `ack_updated_at`, and `result_code`. A null result code identifies an accepted receipt; a rejection code identifies a valid rejected attempt, whose revision/snapshot fields describe the state observed at rejection. Existing client high-water marks remain preserved. Existing owner/chapter primary keys and the owner/chapter/client primary key support reads, counting and uniqueness; no redundant index is added.

PostgreSQL uses the existing transaction-scoped advisory lock, including when no progress row exists. SQLite uses its serialized `BEGIN IMMEDIATE` transaction. State, revision, receipt, completion event and analytics outbox commit atomically. Valid conflict receipts commit without modifying progress/events, then produce HTTP 409; throwing inside the transaction would incorrectly discard that receipt. Exact retries are checked before comparing the now-advanced revision. Older sequences stay retired and cannot be re-executed. Failed validation/admission never bypasses the state precondition.

Metadata is one latest outcome/high-water mark per admitted client/chapter, up to 32 new slots. Older payloads are not retained; their sequence is rejected as retired. Historical pre-migration slots are grandfathered and cannot grow further through this API beyond the cap. There is no time-based forgetting that could silently turn a retired request into a fresh mutation. Guest cleanup removes these rows using the existing owner cleanup; existing registered-owner retention is unchanged. Reaching the cap requires an existing client ID or operator intervention, not silent eviction.

Backups still cover **21 tables**, now with populated revision and accepted/rejected receipt fields verified by snapshot fingerprints and real PostgreSQL restore. SQLite import copies the new fields for newly imported progress, retains existing target progress/revisions, and does not attach imported receipt history to a different retained target state. Import obtains the same progress advisory locks as API writers. Old source schemas use the new column defaults. Keep historical backup manifests with their application/schema version.

## Client behavior and lifecycle

`progressSync.js` contains the account-local protocol coordinator; `PlayerContext.jsx` retains media ownership and the tab queue. It seeds acknowledged revisions from catalog reads, serializes saves after prior acknowledgements, retains the exact body/identity of an uncertain network write for retry, and caps in-memory state at 128 chapters. It does not regenerate identities on a network retry. New requests/decisions allocate new sequences. A returned server state already identical to the requested target can be accepted without another write or dialog; identity-reuse failures are not treated as harmless.

The player has a scoped conflict panel with **Resume Latest** and **Keep My Position**, plus **Refresh Progress**. Resume Latest applies the displayed accepted state paused, seeking the existing media resource in place. Keep writes the local position against the displayed revision; it does not silently borrow a later hidden observation. A new race returns a new conflict. Late acknowledgements cannot clear a newer local seek intent. Account/session and active-occurrence checks prevent stale callbacks updating the next account or chapter. Completion conflicts stop automatic queue consumption; manual navigation remains available.

Foreground/online events are coalesced with a 1.5-second minimum spacing and a trailing event when a request is already active. Manual refresh is single-flight. Foreground reads and writes have eight-second deadlines, and reads abort on owner unmount. There is no periodic GET polling during playback. Current-chapter refresh never switches stories or replaces the queue. Initial login without a tab queue uses existing Continue Listening; a retained queue validates its current occurrence against the server. Clean paused state can adopt automatically; active or locally edited state requires a decision. A small pending rewind is protected too.

The queue envelope retains only its existing references/current position and an optional `baseRevision` hint; old envelopes remain readable. No authenticated revision, receipt, token, email or progress snapshot is written to PWA caches. Download metadata strips revision fields. Offline audio and queue controls remain available. Cold offline bootstrap has no authenticated session; reconnecting that state requires reload/sign-in before private synchronization. A current tab snapshot may retain one local position, but there is **no durable general offline progress or analytics event queue**, and unsaved inactive chapters can require returning to that chapter/retrying before refresh. Offline progress is labeled unsynchronized. A reconnect with unsaved state still needs a decision even if no other device advanced.

## Analytics semantics

Completion remains a false-to-true chapter transition. Repeated accepted or rejected requests add no extra completion events/outbox jobs; reset preserves historical events, clears current completion state and can allow a later genuine completion transition. `completedChapters` continues to count currently completed progress rows. Listening time remains recorded online wall time; seeking is not converted into listening time. Two concurrently playing sessions contribute their actual stream wall times independently, as before; this milestone adds no global single-playback lease or overlapping-session analytics deduplication.

## Safe compatibility and rollout

No release was performed. For a future approved release:

1. Back up the database and verify restore with matching tooling.
2. Drain/stop **all old API writers**; do not roll old unversioned API processes alongside the new protocol. Additive columns alone cannot enforce a protocol in code that does not use it.
3. Run the normal `npm run db:migrate` with the intended database configuration. Startup also migrates. Do not edit applied migration checksums.
4. Release the new API and built frontend together, using the existing same-origin proxy/session settings. Refresh/update old service-worker shells. Old clients receive 428 and must refresh; offline old clients cannot synchronize until updated.
5. Verify two independent signed-in sessions, a stale save, replay, logout isolation and downloaded playback against the approved environment before claiming release success.

Restoring an older database history requires quiescing writers and refreshing clients too; this is not a globally persistent revision epoch across disaster recovery. Future history-removal controls must preserve revisions/tombstones or revoke old writers, rather than deleting a row and resetting its revision to zero.

## Verification and remaining limits

**289 application tests passed (175 backend + 114 frontend), zero failed/skipped; six CI safety tests passed separately.** Ten cross-device browser checks passed on each database with real Redis disconnection/reconnection. Existing suites passed: core 14, auth 5, offline 13, keyboard 3, restart/security 7, playlists 10, settings 8, queue 14. The dotenv-free local CI runner passed test/build/format and all seven browser scripts, including PostgreSQL cross-device checks. Production build transformed 1,709 modules. Installed lockfile dependencies were reused; no clean install, deployment or remote CI run is claimed.

Final commands, counts, changed files and local CI results are in [m1-cross-device-verification.json](m1-cross-device-verification.json). Independent-context evidence: [SQLite](m1-cross-device-browser-sqlite.json), [PostgreSQL](m1-cross-device-browser-postgres.json). Remote GitHub Actions remains **NOT RUN / NOT VERIFIED**. No push, public deployment, production data change or external secret configuration.

During verification, a media network failure exposed unnecessary same-source reload during adoption; adoption now seeks in place and a unit assertion checks that `load()` is not called. Additional regressions covered include an acknowledgement clearing a newer small rewind, queue transitions racing completion/conflict responses, and an account change during pending reads/writes. Tests were upgraded to explicit revision preconditions; old ignored-stale 200 assertions now require 409, not relaxed comparisons. The backup fixture now removes its new child rows and always closes its connection. Backend test-file concurrency is capped at four to avoid observed migration-lock timeout/resource contention; the tests' internal simultaneous SQL/API races still execute.

Limits: current-chapter/event-driven synchronization only; no global device lease, cross-device queue, continuous polling, history-management UI or Creator Studio. Receipt retention/cap and the absence of a durable offline event queue are explicit tradeoffs. Verification is local headless Chrome and local PostgreSQL/SQLite/Redis, not a production-scale or cross-browser claim. Redis checks disconnect/reconnect real clients against a real server; this milestone does not claim a new full Redis-server/container crash drill. The older [M1.3 Chrome hot-cache concern](M1_QUEUE.md) remains separate and is not claimed universally fixed. Public Google provider login, remote CI, production rollout and load benchmarking were not repeated here.
