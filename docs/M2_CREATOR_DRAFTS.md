# M2.2 — private story and chapter drafts

The lifecycle/concurrency contract was recorded before implementation. M2.2 is now implemented and locally verified: **393 application tests, 6 CI safety tests and 134 browser check groups passed**, plus clean install, production build and formatting. No push or deployment occurred; remote GitHub Actions remains NOT RUN.

## Compatibility and lifecycle decisions

Existing bundled stories use low numeric IDs; LibriVox stories use `1000 + provider ID`, and provider chapter IDs are `100000000 + external ID`, strictly below 900000000. Existing public ID parsers accept at most nine digits. Creator IDs therefore use independently allocated story/chapter ranges **900000000–999999999**, with transactional durable high-water counters. Allocation skips occupied IDs, never decreases on import, and never reuses an archived/removed ID. Failed uncommitted allocations may roll back; they have never been returned as successful resources.

Stories remain creator-owned and private, with metadata/revision and `draft` or `archived` state. Archive is soft, irreversible through this milestone's APIs, and retains chapters/receipts. Chapter removal is soft, retains its revision/ID and moves it outside the visible order; it cannot be edited/restored. Active chapters are ordered contiguously from 1. Reordering/removal uses temporary positions above all existing positions inside one transaction to satisfy immediate unique constraints on both databases. Legacy system/provider IDs, ordering, attribution and audio remain unchanged.

Because the existing chapter schema requires audio URL and positive duration, new draft chapters store internal placeholders (empty URL, duration 1). These are not audio or measured duration, are omitted from Studio responses, excluded from all listener/media APIs and skipped by system media processing. Clients cannot choose audio paths/URLs or durations. M2.3 must replace these through a validated private asset lifecycle; this milestone adds no uploads or publishing.

## Authorization and concurrency contract

All Studio operations require an active registered creator. Identity comes only from the validated session; staff has no foreign-draft editing bypass. Authorization and mutations run in the same outer transaction, using M2.1 authorizationService. Locks follow account → allocation counter when needed → resource writes. Imports use the same account/counter order. Suspension is serialized by the account lock; a write accepted before suspension may commit, while later writes are denied.

Story metadata and chapter membership/order advance the story revision; chapter metadata edits advance only that chapter revision. Position changes advance affected chapter revisions. Every edit/archive/remove/reorder carries an explicit expected revision. Chapter creation/removal also carries the expected story revision. Reorder carries the full unique active ID permutation and expected story revision. Different chapters can accept independent metadata edits; stale edits to the same resource cannot silently overwrite data. Conflicts return 409 plus bounded current owned state; no foreign data is returned.

Creation requires a UUID requestId, persisted per owner with a canonical payload hash and resulting story/chapter references in the same transaction. Exact retries return the existing resource's current state, including an archived story/removed chapter, rather than create again. Changed payload/kind/parent/precondition using the same requestId returns 409. These retained receipts support create retries after uncertain responses and restart. Other mutations use compare-and-set: repeating an old expected revision returns 409, requiring a read and explicit decision. No general exactly-once or automatic last-writer-wins claim is made.

Bounds: 100 retained stories per owner; 100 active chapters and 500 retained chapters per story. Story title 1–160, description 0–3000, genre 1–60; language is a syntax-validated 2/3-letter tag with optional region, not a registry lookup. Chapter title 1–160, summary 0–2000. Private list pages default to 20/max 50, ordered by immutable ID descending with an owner-bound cursor. No shared Redis/PWA cache is used.

## REST API

All paths below start with `/api/creator/stories`. Cookie authentication, current active creator status and exact ownership are mandatory for reads and writes. Mutations use the existing `X-CSRF-Token`. GET responses are private/no-store; private data is never cached in Redis. Unknown fields, mutation query parameters and client-selected ownership/status/media are rejected.

| Method/path                     | Request                                                            | Success                                                        |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| GET `/`                         | `limit=1..50` (default 20), optional opaque `cursor`               | 200 `{stories, nextCursor}`; includes own archived stories     |
| POST `/`                        | `{title, description, genre, language, requestId}`                 | 201 detail; exact receipt replay 200                           |
| GET `/:id`                      | No query selectors                                                 | 200 detail                                                     |
| PUT `/:id`                      | All four metadata fields plus `expectedRevision`                   | 200 detail                                                     |
| POST `/:id/archive`             | `{expectedRevision}`                                               | 200 detail; already archived with current revision is a no-op  |
| POST `/:id/chapters`            | `{title, summary, requestId, expectedStoryRevision}`               | 201 detail plus `chapter`; exact replay 200                    |
| GET `/:id/chapters/:chapter`    | No query selectors                                                 | 200 `{storyRevision, chapter}`; own removed marker is readable |
| PUT `/:id/chapters/:chapter`    | `{title, summary, expectedRevision}`                               | 200 detail                                                     |
| DELETE `/:id/chapters/:chapter` | `{expectedRevision, expectedStoryRevision}`                        | 200 detail plus removed `chapter`                              |
| PUT `/:id/chapters/order`       | `{chapterIds: [complete active ID permutation], expectedRevision}` | 200 detail; identical order does not bump revisions            |

Metadata edits replace the documented metadata fields, not arbitrary database columns. Detail is `{story, chapters}` with at most 100 active chapters in deterministic order. Story shape is `{id,title,description,genre,language,state,revision}`; chapter shape is `{id,title,summary,position,revision,removed}`. Removed markers have `position: null`. Creates include `replayed`. Server IDs are numeric; path IDs are canonical positive nine-digit-or-shorter strings.

Errors use `{error:{code,message}, current?, chapter?}`. Validation is 400 (`INVALID_DRAFT_REQUEST`/`INVALID_DRAFT_ORDER`); missing revision is 428 (`DRAFT_PRECONDITION_REQUIRED`); missing session 401; guest/inactive/suspended creator 403. Foreign and absent resources share the same 404. Revision conflicts return 409 `DRAFT_CONFLICT` and the latest authorized detail. Archived/removed writes use `DRAFT_ARCHIVED`/`CHAPTER_REMOVED`; caps/exhaustion use `DRAFT_LIMIT`; changed receipt payload uses `DRAFT_REQUEST_REUSED`. Existing CSRF, rate-limit and global unexpected-error envelopes remain unchanged. No stack traces or foreign state are returned.

Individual removal with old revisions conflicts, including a repeated accepted removal. Reading the removed marker and supplying its current chapter and parent revisions allows a repeat-safe no-op. Archive behaves similarly: a repeat with the old precondition conflicts, while the current archived revision returns unchanged state. Successful old create receipts may still be acknowledged after removal/archive; they never restore content.

## Schema, import and recovery

Additive PostgreSQL `015_creator_drafts.sql` and SQLite `016_creator_drafts.sql` extend stories/chapters with constrained revisions, private lifecycle fields, language and summary. `creator_id_allocations` owns independent durable high-water counters. `draft_create_receipts` has an owner/request UUID primary key, canonical hash and composite foreign keys enforcing story owner and chapter parent. New list/order/relationship indexes support bounded private reads and FK integrity. Existing listener relationships are retained.

SQLite import validates creator metadata, preserves existing target identity/suspension, takes account locks then both allocation locks in fixed order, and imports a new private story with its children/receipts transactionally. If its parent already exists in the target, the entire target chapter collection wins; stale source children are not attached and revisions are never reset. ID/parent or receipt-identity conflicts abort the import. Source/target high-water counters are reconciled without decrement, even for skipped source rows. Seed reruns retain creator rows. Backups inventory 24 tables, including nonempty receipts, archived/removed state and counters; the restore test compares fingerprints in a separate database. Compatibility with 21/22-table manifest shapes is retained; testing an older manifest against a current archive is not proof of restoring every historical archive version.

Before any future rollout, drain older API/seed/import binaries, back up, apply additive migrations once and run the new code together. Older import binaries do not understand private collections/receipts. No deployment, developer migration or production data change was performed for this milestone.

## Studio and safety boundaries

`/studio` extends the current navigation/style with My Stories, bounded Load More, metadata forms, chapter add/edit/remove/move, archive confirmation, draft/dirty states and recoverable errors. Registered creators activate access through the existing `/creator` flow. Archived drafts are read-only. Changes do not replace the shared audio player or alter playlists, queues, offline files, progress or analytics.

A 409 shows the authorized latest story and chapter metadata. Reload discards local changes; Review My Changes fetches current state and preserves metadata for inspection and a separate explicit Save. Reorder/removal are never automatically replayed. Uncertain creates lock fields and retain the original UUID/payload/precondition while the editor is mounted; refreshing the server view does not generate a new key. Requests are scoped to the account/session and aborted/retired on switches, including a successful response deliberately delayed across logout/login in browser tests. Invalid Studio query IDs cannot construct API paths. React text rendering handles markup as text.

Pending create keys and unsaved edits are tab-memory only. Leaving/unmounting Studio, browser refresh or switching accounts may lose a retry key; accepted server records remain in My Stories. The internal My Stories action confirms dirty/uncertain state, but general app/browser navigation has no global unsaved-edit blocker. There is no offline Studio write queue, cross-device draft merge, hard deletion/retention policy, undo, audio upload, preview, publishing or moderation. The creator UI is network-only; active status is checked by the server on every operation. Existing request-body/rate limits apply, without throttling legitimate audio range requests.

## Verification and next step

Exact executed checks, counts, changed files and known limitations are recorded in [m2-creator-drafts-verification.json](m2-creator-drafts-verification.json). Browser evidence uses disposable PostgreSQL schemas and in-memory SQLite with real HTTP/Chrome and real bundled audio. Test failures encountered during development and their corrections are recorded there. Local checks do not establish remote GitHub Actions success or production readiness.

For M2.3, first define private asset ownership and chapter FK/state, storage adapter and object-key policy, bounded signed access, quarantine/validation limits, cleanup/retry semantics and orphan recovery. Only then add upload initiation/completion and safe worker input. Keep drafts excluded from public media/offline caches until a separately tested publishing policy exists. This milestone requires no extra services or dependencies.
