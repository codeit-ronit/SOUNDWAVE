# M2.6 + M2.7 — Publishing and moderation

Local verification: **466 application tests (306 backend + 160 frontend), 6 CI safety tests and 170 browser check groups passed**. Clean installation, production build and formatting passed. Evidence: `m2-publishing-verification.json`. No deployment or remote Actions execution.

## Contract

Story-level review covers every active chapter: exact story/chapter revisions, metadata/order, current validated source/head, processor version and immutable ready MP3 ID/checksum. The server checks actual output bytes at submission, review decision and publication. All chapters must be technically ready. This is bounded streaming file I/O inside the owner-locked transaction, never encoding; large 100-chapter submissions may hold the transaction longer and need M3/M4 tuning.

`draft → submitted → approved → published → unpublished`. Rejection requires resubmission; submitted/approved work may be withdrawn. Staff revocation and creator suspension/deactivation require fresh submission and approval. Unchanged voluntarily unpublished content can be republished under its existing approval; any changed content needs resubmission. Editing metadata/order or uploading/deleting current media requires withdrawal/unpublishing first. Existing queued uploads cannot attach across a locked review. Old processing jobs never set publication state.

Submission requires explicit `attest: true` and `termsVersion: creator-rights-v1`: the creator declares permission to distribute all metadata/audio. The declaration, timestamp and version are durable audit evidence, **not independent rights verification**. Every review binds exact identities; a changed/missing/corrupt output cannot be approved/published. No public moderator registration or self-review is permitted. Moderator/admin roles use the existing operator provisioning tool. Both may approve/reject/revoke; only admins may suspend an entire creator through the dashboard. Staff cannot edit another creator’s draft or use arbitrary private previews.

Every mutation requires `expectedRevision` (initial 0) and UUID `requestId`. Transactions lock owner/actor accounts in sorted order, recheck current authorization, enforce transitions, save audit + receipt and change catalog revision together. Repeated identical requests return current authorized state with `replayed: true`; reused IDs with different payloads return 409. Concurrent opposing decisions have one winner; failures roll back publication/audit/receipts. SQL and filesystem are not jointly atomic: immutable existing files are verified, never copied at publish; missing files fail closed and require private processing recovery + fresh approval.

## REST API

All private endpoints use existing session/CSRF/account-scope protections and `private, no-store`; unknown body fields/selectors are rejected. No owner/role/status fields are accepted.

| Endpoint                                                                     | Behavior                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET `/api/creator/stories/:id/publication`                                   | Own status, current terms, last 100 audit entries                                      |
| POST `.../publication/submit`                                                | Preconditions plus `attest`, `termsVersion`                                            |
| POST `.../publication/withdraw`, `/publish`, `/unpublish`                    | Revision-aware explicit transition                                                     |
| GET `/api/moderation/submissions`                                            | First 50 pending submissions by story ID; decided/withdrawn rows leave this worklist   |
| GET `/api/moderation/stories/:id`                                            | Review status/history and current matching submission metadata                         |
| GET/HEAD `.../:id/outputs/:output/stream`                                    | Staff-only exact current submitted/approved/published snapshot MP3, ranges supported   |
| POST `/api/moderation/stories/:id/approve`, `/reject`, `/revoke`, `/suspend` | Revision/request ID, required bounded `note`, controlled `code`; suspension admin-only |

Codes: approval `approved`; rejection/revocation/suspension `rights_concern`, `content_policy`, `audio_quality`, `metadata_issue`. Errors use `{error:{code,message}}`, including 400 invalid contract, 401/403 identity/role, generic 404 foreign resource and 409 stale revision/readiness/transition. Refresh before a new decision; uncertain network outcomes retry the original request ID/payload.

## Public boundary and offline policy

Live SQL eligibility gates catalog detail/list/search, chapters, favorites, playlists, history/progress, recommendations and playback analytics. Published duration comes from actual decoded MP3 metadata. Catalog revision changes transactionally; cached metadata is additionally filtered by current SQL visibility. Public MP3 requests use the existing `/api/chapters/:id/stream`, with 200/206/416 and HEAD, `no-store`, immutable checksum ETag, and another eligibility check after opening storage. Private paths/owner IDs/moderation fields are not public. System/LibriVox routes retain their existing behavior. Revocation preserves listener records and playlist membership while hiding inaccessible stories.

Published creator MP3s are eligible for explicit offline download. `cache: no-store` downloads always reach the server. Online playback of a downloaded creator file checks a fresh HEAD gate and ETag; known revocation deletes the cached audio and refuses new reads. Offline/disconnected devices can continue replaying earlier copies; buffered/in-flight bytes, exported copies and cached metadata cannot reliably be recalled. Network timeouts may fall back to an existing copy. This is access revocation, **not instant deletion or DRM**. Private review/upload routes never enter audio caches.

## Schema, recovery and limits

Additive PostgreSQL `018_publishing.sql` / SQLite `019_publishing.sql`: `story_publications`, `publication_chapters`, `publication_audit`, `publication_receipts`, keys/checks/FKs/indexes. No prior data is published by migration. Audit operations have no edit/delete HTTP endpoint; database operators can still alter database records (no cryptographic tamper-proof claim).

Backup inventory now includes 32 tables, retaining prior manifest support. SQLite import preserves review/audit metadata but makes new imported publications withdrawn with an advanced revision, cleared active approval and explicit restore/review requirement; matching private files are outside DB-only archives. Existing target publications win. Restoring a matching full database/files volume may restore its historical publication state; operators must deliberately reconcile later takedowns before opening a restored service.

Pending moderation has a fixed bounded worklist, not arbitrary SQL queries. UI decision history is capped at 100; durable rows remain. No scheduled publishing, automated rights verification, external object storage/CDN, tamper-evident audit, content-policy automation or publication notifications. No production capacity/cross-browser claims. M3/M4 should harden audit retention, transaction latency, storage integrity monitoring, global disk/backlog controls and recovery/takedown procedures before a public release.
