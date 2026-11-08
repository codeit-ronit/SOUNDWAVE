# M1.4 — listening history and privacy controls

Implemented and locally verified on `feature/m1-private-playlists`, 8 November 2026. The semantics contract was written before implementation. No push or deployment was performed.

## Data semantics

| Data                         | Meaning                                                                      | Individual removal / clear                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Saved playback progress      | Current bookmark, completion marker and server revision for an owner/chapter | Hide the row and clear an incomplete bookmark to zero; preserve completion and its end marker; advance revision |
| Currently completed chapters | Completion flags used by current completion totals/recommendations           | Retained; removal is not an implicit reset                                                                      |
| Listening events / time      | Historical online wall-time, favorite and completion transition events       | Retained; no events or listening seconds added/deleted by removal                                               |
| Continue Listening           | A view derived from visible saved progress                                   | Removed chapters disappear; another visible chapter in the story may still qualify                              |
| Device queue/history         | Per-tab playback occurrences and navigation history                          | Unchanged; removal does not stop or remove active/queued audio                                                  |
| Analytics rollups/outbox     | Derived snapshots and pending aggregation work from events                   | Unchanged because events remain unchanged                                                                       |

Removal is **not full privacy erasure**. Analytics, completion markers, idempotency metadata, backups and public offline downloads remain. Recommendations may still use retained completion information. No full analytics/account deletion endpoint is introduced.

## Consistency contract

Keep a minimal tombstone in `listening_progress`, not a physical delete. A visible row's removal increments its revision once, marks it removed and clears an incomplete position; a repeat removal is an effect-free acknowledgement. Prior progress receipts/high-water identities remain. Ordinary updates cannot restore a tombstone even with a freshly read revision; the M1.5 explicit `reset` action can restore it, with its current revision and a new identity. Stale saves conflict, and a replayed old receipt only acknowledges its old outcome while returning the current tombstone.

All progress/history mutations lock the authenticated owner before the existing chapter advisory lock. An account-wide history revision advances on visible progress changes, resets and removals. Bulk clear requires this revision and explicit confirmation, updates only currently visible saved rows atomically and increments each affected chapter revision. Repeating clear while empty is a no-op; a stale retry after new activity conflicts. A first save for a previously untracked chapter after clear is new activity, not restoration of a removed record.

History pages use a bounded live cursor view ordered by exact database timestamp descending and chapter ID descending. PostgreSQL cursor timestamps retain microsecond precision. A deleted boundary need not exist for the next page. Cursors are owner-bound inputs, never authorization credentials. New/updated rows above a prior boundary require refreshing the list.

## Database and write protocol

Additive migrations are PostgreSQL `013_history.sql` and SQLite `014_history.sql`. They add constrained `users.history_revision`, `listening_progress.history_removed` and the partial `(user_id, updated_at DESC, chapter_id DESC)` visible-history index. Existing rows remain visible. No new tables are introduced; backup manifests still contain 21 tables, with the new columns included automatically. Populated migration/reapply, SQLite-to-PostgreSQL import, retained destination tombstone, and actual PostgreSQL backup/restore tests cover the new state.

Lock ordering is owner row → chapter advisory lock for progress and individual removal; bulk clear holds the owner lock for its set-based update. SQLite uses its existing serialized transaction adapter. GET History briefly takes the same owner lock in a transaction so entries and the bulk-clear guard represent one consistent point. This serializes one account's progress mutations; it is a correctness tradeoff, not a throughput claim. Import follows the same lock order. Failed transactions roll back bookmarks, tombstones and guards together.

Every visible state change or explicit reset increments `history_revision`; metadata-only receipt writes and equivalent saves do not. Removal increments the chapter revision once. Revision overflow fails instead of wrapping. Previous accepted and rejected identity receipts remain valid only for their original outcome. A replayed old accepted identity can return 200 with its original acknowledgement revision **and the current removed state**; it cannot write the old position again. New stale attempts receive 409 and current authorized state. An ordinary update at a current tombstone revision receives `PROGRESS_RESET_REQUIRED`; only explicit `action: "reset"` at the current revision restores the bookmark. The frontend blocks queued pre-removal reset snapshots and automatic queue transitions from restoring known removed history.

Deploy the schema before the new API, then replace/drain all older API instances before enabling removal. Older binaries do not enforce tombstones; running them concurrently would violate this contract. Migration rollback by deleting columns is not a supported operational procedure. Restoring an older backup can restore older data/revisions; offline writers must be retired during disaster recovery. No backup-retention or full-erasure guarantee is made.

## REST contract

All paths below are under `/api`, session authenticated, owner-derived, private/no-store, and excluded from shared Redis and service-worker caches. DELETE requires the existing CSRF header. Client-supplied owner selectors and unknown fields/query parameters are rejected. Existing general API throttling applies; public range streaming remains exempt.

| Method | Path                                     | Request                                                                                 | Success                                            |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/history`                               | `limit` optional integer 1–50 (default 20), `cursor` optional opaque owner-bound cursor | `{ entries, nextCursor, historyRevision }`         |
| DELETE | `/history/:chapterId`                    | JSON `{ "expectedRevision": 3 }` from the rendered entry                                | `{ removed: true, historyRevision, progress }`     |
| DELETE | `/history` (also accepts trailing slash) | JSON `{ "expectedHistoryRevision": 5, "confirm": "CLEAR_SAVED_HISTORY" }`               | `{ cleared: true, removedCount, historyRevision }` |

Entries contain chapter/story IDs and titles, chapter number, duration, saved position, completion, revision, update timestamp and public story metadata for the shared player. `nextCursor` is null at the end. Ordering is exact timestamp descending, then chapter ID descending. Cursors are bounded, canonical base64url with version, current owner, timestamp and chapter boundary. They are validated input, not signed capabilities; they never authorize another owner's data. Rows deleted at a boundary need not still exist. This is live pagination, not a multi-page snapshot: refresh to see newer/moved entries above a previous boundary. The client deduplicates appended results and does not adopt a newer clear guard from an appended page.

Malformed requests return 400; anonymous access 401; invalid CSRF 403. An owned visible entry with an outdated revision returns 409 `PROGRESS_CONFLICT` with current own `progress`. Already removed entries acknowledge without another mutation even when repeated with the old removal revision. Missing and foreign entries both return generic 200 with `progress: null`; no foreign state is disclosed. A stale clear guard when visible rows exist returns 409 `HISTORY_CHANGED` with the current own history revision. Clearing an empty history returns 200/count 0 without incrementing revisions. A repeated old clear after new activity conflicts. Bulk clear does not return an unbounded list of affected chapters.

`GET /progress/:chapterId` and story chapter reads now expose `removed`. The legacy `/progress` saved-list and Continue Listening exclude removed rows; authenticated direct chapter state retains the tombstone revision. A story may remain in Continue Listening when another visible chapter qualifies. Recommendations may still use retained completion markers. Removal does not emit completion/favorite/listening events or alter analytics rollups/outbox jobs.

## Frontend and privacy behavior

`/history` provides Resume/Replay, individual removal, confirmed clear, Load More, Refresh and recoverable error states. Clear/removal conflicts require a refresh and renewed confirmation. The current audio element is preserved; queue entries and tab-local positions remain. The active writer adopts the marker, suppressing automatic bookmark writes. Explicit Play/Replay or the conflict choice **Restore My Position** can restore saved progress through the reset protocol; **Keep Removed** adopts the tombstone without stopping audio. Another device discovers removal through the existing progress refresh/conflict protocol, not a new push service.

Account/session-keyed views abort reads and mutations on account changes and discard late responses. Abort cannot undo a mutation already accepted for the old owner; it prevents the old response from populating the new owner's UI. Guests use isolated session owners and retain markers/guards on account upgrade. Signed-out/offline history management is unavailable. Public downloaded audio remains playable offline; removal is not download deletion. Future playback may still generate listening analytics, even while its saved bookmark stays removed.

No analytics erasure or account deletion endpoint is added. A future separate full-data operation needs explicit policy, event/rollup/outbox transactional cleanup, backup-retention disclosures and independent tests. This operation does not promise that.

## Verification and limitations

Local results: **321 application tests passed** (195 backend + 126 frontend), **6 CI safety tests**, and **98 browser check groups** across the required suites and both History database flows. All backend cases executed with zero failures/skips. Clean Node 22 `npm ci`, production build, formatting and the exact local CI test/build/format/browser runner modes passed. Exact commands/results are recorded in [m1-history-verification.json](m1-history-verification.json). Browser results use temporary SQLite or generated PostgreSQL schemas, local headless Chrome and real audio. They do not establish cross-browser compatibility or public deployment. The mandatory CI runner now requires PostgreSQL history migration/race/guard coverage and includes the bounded History browser script. **Remote GitHub Actions remains NOT RUN / NOT VERIFIED.**

Remaining limits: live pagination can require refresh during playback; old `/progress` remains unpaginated for backward compatibility (new History is bounded); owner-level locking should be measured before changing concurrency strategy; tombstone/receipt retention is required for revision safety and is not physical privacy erasure. Device-wide public downloads and tab queue positions remain by design. No durable general offline write queue, cross-device queue sync, Creator Studio, production data changes, push or deployment is included.
