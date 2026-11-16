# M1.2 — private named playlists

Implemented on **`feature/m1-private-playlists`**, 7 November 2026, from M0 commit `286dd90`. **Local implementation only: no push or deployment performed.** The public demo does not acquire this feature until a separately approved release.

## Commit inventory

The fixed M1.2 range `286dd90..33d07ec` contains **five implementation/test commits and one documentation commit (six total)**. The evidence JSON was generated before its own final commit `33d07ec`, so its original implementation-only list correctly contained five entries. The reconciled evidence records the complete range and documentation commit separately; later CI commits are outside this milestone.

## Delivered behavior

My Library now has a Playlists section alongside existing favorites and Continue Listening. Registered users and isolated guests can create, open, rename and delete private collections, add/remove stories, and play a selected story through the existing StoryCard/player. Selected collections use `/library?playlist=UUID`, so refresh restores the view. Loading, empty, success, validation/network errors, retry and deletion confirmation are implemented. Favorite membership, playback history, recommendations and public offline downloads retain their existing semantics.

Guests retain playlists when registering with a password or Google because the owner UUID remains unchanged. Logout/account switching discards private UI state; a different registered account in the same browser receives a generic not-found result for the previous owner's collection. Pending reads are aborted, and requests capture the original session/owner guard instead of acquiring another account's client scope.

No editable playback queue, creator workflow, upload endpoint, new infrastructure or dependency was added.

## Database and transaction design

- PostgreSQL: [009_playlists.sql](../server/migrations/postgres/009_playlists.sql).
- SQLite: [010_playlists.sql](../server/migrations/sqlite/010_playlists.sql).
- `playlists`: UUID text primary key, `user_id` FK with cascade, bounded name, immutable millisecond creation timestamp, updated timestamp and monotonic next-position counter. Owner/creation/ID index supports keyset pagination.
- `playlist_items`: playlist/story FKs, unique playlist/story membership, positive position, unique playlist/position and added timestamp. Story lookup index; playlist cascade removes only its membership. Deleting a playlist never deletes catalog stories, favorites, history or downloaded files.
- All writes are transactional. PostgreSQL locks the owned parent row; SQLite uses the existing serialized `BEGIN IMMEDIATE` adapter. A fresh count query **after** lock acquisition avoids a stale pre-wait READ COMMITTED count when concurrent additions race for the last slot. Duplicate additions do not advance order or timestamps, even at capacity. Remove/re-add appends a story at the end; no reorder feature was introduced.
- Ownership is derived exclusively from session identity. Parent access is owner-scoped; membership writes run only after locking that owned parent. Valid unknown and foreign playlist IDs have identical 404 responses. Client owner/user fields are rejected.
- Existing migrations/checksums are unchanged. Fresh and pre-playlist upgrade fixtures preserve favorites, sessions and progress. Expired guest cleanup cascades new tables; registered users remain retained. The SQLite importer includes both tables, locks existing target parents, transactionally rejects foreign ownership or merged membership/order overflow, and advances retained append counters beyond imported positions. Existing target names/keys are not overwritten; skipped conflicts still require review.
- Backup/restore manifests now include **20 tables**. Tests create actual playlist/item rows and verify all restored fingerprints, rather than only testing empty new tables. Older 18-table manifests belong to the earlier app/schema checkpoint and must be restored using the matching version before upgrading.

Sources: [repository](../server/repositories/playlists.js), [service](../server/services/playlists.js), [routes](../server/routes/playlists.js).

## REST contract

All paths below start with **`/api`** and require a valid registered/isolated-guest session. Writes reuse `X-CSRF-Token` plus existing Origin/Fetch Metadata checks. The existing general rate limiter and configured-Redis protected-operation failure policy apply. Audio remains exempt from those general limits. All playlist responses are **`Cache-Control: private, no-store`**, vary on Cookie, and bypass the shared catalog cache. No private playlist is persisted by the service worker.

| Method | Path                              | Request / response                                                                                                                                         |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/playlists`                      | Optional `limit` (default 20, integer 1–50) and `cursor`; 200 `{ playlists, nextCursor }`. Unknown query fields/repeated or malformed values are rejected. |
| POST   | `/playlists`                      | `{ "name": "Evening escapes" }`; 201 `{ playlist }`. No owner/ID fields accepted.                                                                          |
| GET    | `/playlists/:id`                  | 200 `{ playlist, stories }`; at most 100 stories, in insertion order, with existing story serialization and current-owner favorite flags.                  |
| PUT    | `/playlists/:id`                  | `{ "name": "Night drives" }`; 200 `{ playlist }`. Creation order is unchanged by rename.                                                                   |
| DELETE | `/playlists/:id`                  | Empty body or `{}`; 204. Unknown/foreign playlist: 404.                                                                                                    |
| PUT    | `/playlists/:id/stories/:storyId` | Empty body or `{}`; 200 `{ playlist }`. Idempotent duplicate addition; unknown story: 404; full collection: 409.                                           |
| DELETE | `/playlists/:id/stories/:storyId` | Empty body or `{}`; 204. Removing an absent valid story ID is idempotent; unknown/foreign playlist remains 404.                                            |

Playlist summary:

```json
{
  "id": "a0000000-0000-0000-0000-000000000001",
  "name": "Evening escapes",
  "createdAt": "2026-11-07T00:00:00.000Z",
  "updatedAt": "2026-11-07T00:00:01.000Z",
  "storyCount": 2
}
```

Names are trimmed, **1–80 Unicode code points**, without control characters. Duplicate names are allowed; identity is the UUID. The API accepts a UUID playlist ID (case normalized) and positive numeric catalog story IDs. Membership is unique and limited to **100 stories**. The story picker lists the current catalog and excludes already-added stories; capacity and uniqueness are enforced on the server regardless of UI state.

List order is `(created_at DESC, id DESC)`. `nextCursor` is opaque base64url JSON containing the last immutable timestamp/UUID; pass it unchanged to the next request and stop at null. Cursor shape, date range and size are validated. A caller can construct a cursor but cannot select another owner: every query still filters by the current session user. Deletion of a previous page boundary does not skip the next page. Pages are live views, not a transactionally frozen catalog snapshot.

Domain failures retain the existing `{ error: { message } }` shape and add a feature code:

| Status / code                  | Meaning                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| 400 `INVALID_PLAYLIST_REQUEST` | Invalid name/ID/query/cursor/body or extra fields.                            |
| 404 `PLAYLIST_NOT_FOUND`       | Valid UUID does not identify a playlist owned by this session.                |
| 404 `STORY_NOT_FOUND`          | Requested addition has no matching catalog story.                             |
| 409 `PLAYLIST_FULL`            | New addition would exceed 100 stories. Existing membership still returns 200. |
| 409 `PLAYLIST_ORDER_LIMIT`     | Monotonic counter cannot safely advance; defensive numeric bound.             |

Session/CSRF/stale-account/rate failures keep the existing shared 401/403/409/429/503 contracts; malformed JSON/body-size errors use the existing global error handler. Unexpected database errors are generic 500 responses. There is no raw SQL or server-stack disclosure in playlist errors.

## Actual verification

Host: Node 22.21.1, Apple Silicon, installed Chrome; isolated PostgreSQL 18.6 database/schemas and dedicated local Redis 7.4. No production data or existing developer services were stopped or deleted. Full machine-readable checks/log fingerprints are in [m1-playlists-verification.json](m1-playlists-verification.json).

| Executed check                                                | Result                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full `npm test` with real PG, Redis and matching backup tools | **178 passed**: 141 backend + 37 frontend; 0 failed/skipped. Existing 153-test baseline retained and extended.                                                                                                                                                    |
| New playlist API/integration cases                            | **18 passed** across both adapters, including real Redis private-cache checks.                                                                                                                                                                                    |
| New frontend cases                                            | **6 passed**: creation, pending duplicate-submit guard/error recovery, pagination/retry, confirmation/membership error, stale read/account change and signed-out/offline behavior.                                                                                |
| Extended existing tests                                       | Password and signed-Google guest upgrades, pre-playlist upgrades/import conflict protection, populated 20-table backup/restore. Google uses the existing locally signed JWT/JWKS verifier fixtures; no new public Google login was attempted.                     |
| Production frontend build                                     | **PASS**, 1,703 modules.                                                                                                                                                                                                                                          |
| Formatting                                                    | **PASS**; configured npm check plus explicit changed-doc/JSON check.                                                                                                                                                                                              |
| New real browser playlist flow                                | **10 passed PostgreSQL + 10 passed SQLite**: CRUD/order/errors, real audio, refresh/progress, guest upgrade, same-browser registered-account switching, independent guest isolation, pagination, deletion/download preservation, cache privacy and mobile layout. |
| Existing browser suites                                       | **14 core + 5 auth + 13 offline + 3 keyboard + 7 restart/security checks passed**; the restart suite needed an isolated rerun as noted below. Auth cache exclusion now explicitly includes playlist paths.                                                        |
| Focused audio regression                                      | New disconnect test reproduced a descriptor leak before the fix; **9/9 stream tests passed** afterward.                                                                                                                                                           |

The browser runner creates 21 additional collections through the real API to exercise pagination. Its recoverable-read test injects one controlled HTTP-503-shaped fetch response; it does not claim to simulate a real Redis/database outage. Its download is actual bundled audio. [PostgreSQL browser results](m1-playlists-browser-results.json), [SQLite browser results](m1-playlists-sqlite-browser-results.json).

### Observed failures and corrections

The real story picker initially had an ambiguous label containing its option text; an explicit accessible name fixed the Chrome failure. The cache regression test initially assumed every Redis SCAN batch was nonempty; it now skips legitimate empty batches and asserts that real cached entries were inspected. These were corrected and rerun before final completion.

Browser interruption also exposed a real existing streaming race: a client could disconnect while `open/stat` awaited, before the response close listener was installed, leaving an opened descriptor for garbage collection. A deterministic regression test failed with the descriptor still open. The minimal fix checks `res.destroyed` after stat and explicitly closes the handle; it preserves existing range/HEAD behavior. Both full playlist browser flows were rerun afterward without the observed warning. This is a targeted listening reliability fix, not a streaming redesign.

One repeated run of the existing restart/browser audit timed out while waiting for exact paused-position restoration after two successful checks. An isolated rerun passed all seven unchanged assertions. The cause was not established; this remains a browser-test stability follow-up rather than evidence that the failure cannot recur. Both playlist-specific browser suites passed, including their own refresh/paused-position assertions. **M6.1 follow-up:** repeated isolated reproduction identified a test synchronization error and corrected it without changing the player/server; see [the investigation](CI_FLAKE_INVESTIGATION.md). The earlier results remain historical evidence.

### Reproduce

```bash
# Use a disposable local PostgreSQL database, not developer/public data.
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database npm run db:migrate
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 \
TEST_BACKUP_CONTAINER=YOUR_MATCHING_LOCAL_POSTGRES_CONTAINER npm test
npm run build
npm run format:check
npm run test:playlists:browser
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database npm run test:playlists:browser
node scripts/auth-smoke.mjs
node scripts/offline-smoke.mjs
node scripts/keyboard-smoke.mjs
node scripts/audit-smoke.mjs
```

`playlists-smoke.mjs` uses a temporary SQLite fixture or creates/drops only a generated schema in the provided loopback PostgreSQL database. It needs the production bundle and installed Chrome/Playwright Chromium. The actual local run used PostgreSQL port 55433 and Redis 56399; credentials are intentionally omitted here. The existing core browser script writes screenshots; the task restored only its own regenerated screenshots rather than committing unrelated image churn.

## Exact changed files

| Area                        | Files                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Additive migrations         | `server/migrations/postgres/009_playlists.sql`, `server/migrations/sqlite/010_playlists.sql`                                      |
| API/application             | `server/app.js`, `server/routes/playlists.js`, `server/services/playlists.js`, `server/repositories/playlists.js`                 |
| Data preservation           | `server/database/import-sqlite.js`, `server/operations/backup.js`                                                                 |
| Backend tests               | `server/test/playlists.test.js`, `server/test/migration.test.js`, `server/test/backup.test.js`, `server/test/google.test.js`      |
| Targeted streaming fix/test | `server/routes/stream.js`, `server/test/stream.test.js`                                                                           |
| Frontend                    | `client/src/Playlists.jsx`, `client/src/Playlists.test.jsx`, `client/src/api.js`, `client/src/pages.jsx`, `client/src/styles.css` |
| Verification/scripts        | `scripts/playlists-smoke.mjs`, `scripts/auth-smoke.mjs`, `package.json`                                                           |
| Documentation/status        | `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/SOUNDWAVE_V3_ROADMAP.md`, `docs/M1_PLAYLISTS.md`                 |
| Evidence artifacts          | `docs/m1-playlists-browser-results.json`, `docs/m1-playlists-sqlite-browser-results.json`, `docs/m1-playlists-verification.json`  |

## Known limits and follow-ups

- This branch is not pushed or publicly deployed. Merge/release/migrations require a separately approved action; no cloud configuration changed.
- Collections contain stories, not individual chapter queue entries. No manual reordering, sharing, collaborative editing, playlist covers or editable playback queue is implemented.
- Playlist metadata is online-only. Downloads remain public device-local content; playlists/private edits are not synchronized offline or cached. Independent devices see changes on refresh/refetch, not live push. Rename conflicts serialize with last committed name winning; optimistic versions belong to later correctness work.
- The existing catalog API still returns its full list for the story picker; broader catalog pagination/search remains M3 work. Playlist lists themselves are bounded. There is no total per-user collection/storage quota beyond existing route limits and the 100-story cap.
- Creation is not idempotent across a lost response and manual retry; duplicate names are permitted. UI suppresses simultaneous submits in the current component but does not claim exactly-once creation across network failures.
- Limits/order are enforced by transactional service writes; manual administrative SQL must respect those rules. No audit claim covers arbitrary administrator writes.
- Chrome desktop/mobile-viewport evidence is not Safari/Firefox/physical-device certification or a production security/scaling assessment. Existing free-hosting/Redis/email/backup limitations remain.

M1.2 is complete; M1.1 settings, M1.3 queue editing, creator functionality and the broader V3 roadmap remain separate tasks.
