# M2.1 — creator identity and ownership

Implemented and locally verified on `feature/m1-private-playlists`, 10 November 2026. Policy was defined before implementation. No push or deployment was performed.

## Permission matrix

| Identity                | Public catalog/audio | Own listener data                            | Creator onboarding                                 | Own creator profile                 | Owned story authorization                    | Staff authorization                                                        |
| ----------------------- | -------------------- | -------------------------------------------- | -------------------------------------------------- | ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Anonymous               | Yes                  | No                                           | No                                                 | No                                  | No                                           | No                                                                         |
| Isolated guest / legacy | Public only          | Guest's own data only; legacy cannot sign in | No                                                 | No                                  | No                                           | No                                                                         |
| Registered listener     | Yes                  | Own only                                     | Automatic activation by explicit request           | No profile until activation         | No                                           | No                                                                         |
| Active creator          | Yes                  | Own only                                     | Duplicate activation acknowledges existing profile | Own read/edit/deactivate            | Active role AND exact creator owner required | No                                                                         |
| Inactive creator        | Yes                  | Own only                                     | May explicitly reactivate                          | Own read; reactivate before editing | No                                           | No                                                                         |
| Suspended creator       | Yes                  | Own only                                     | Denied; only operator can lift suspension          | Own read only                       | No                                           | No                                                                         |
| Admin / moderator       | Yes                  | Own only                                     | Same creator policy                                | Own only                            | Same active creator + ownership requirement  | Explicit role check for future staff routes; no such public routes in M2.1 |

Registered accounts can activate automatically because this slice grants only a private creator identity/profile, not publication, uploads, moderation or access to other users. Email verification remains independently displayed and does not confer staff status. Password and Google sign-in share the existing account UUID; creator identity is keyed to that UUID, never email or Google subject. Guest-to-account upgrade retains the UUID but does not itself activate creator access. A suspended creator cannot bypass suspension by activation/deactivation/profile edits. Suspension never deletes listener data or owned content.

Staff role defaults to listener for everyone. No first-user elevation or public role setter. An explicit operator CLI can change staff role/status; it is not exposed through HTTP and must be run against an intentionally selected database. Operators hold database access and are trusted. Admin/moderator does not imply unrestricted listener-data access or cross-creator editing. Future moderation capabilities must be separate allowlisted checks/endpoints.

## Ownership baseline

Every story has explicit system, external or creator ownership. Existing source attribution is retained; LibriVox stories are external, bundled stories system. Creator ownership requires a real creator profile and a registered account. System/external stories have no creator owner. No client chooses role, owner or provenance. No ownership-transfer endpoint is introduced.

All creator-owned stories are excluded from listener catalog, discovery, chapter and audio APIs in this milestone; there is no publishing state/workflow yet. Public serializers omit owner metadata. Startup seeds and external imports must preserve creator-owned rows and refuse ownership collisions. SQLite import is an explicit trusted operator action, preserves existing target profile/role/state, and rejects conflicting story ownership atomically. Backups include creator identity and ownership columns.

No upload, story editor, publishing or moderation API is included. M2.2 should add private draft CRUD with immutable server-set ownership, optimistic edit revisions, bounded pagination and object-level authorization, while keeping drafts out of listener reads.

## Data model and authorization

PostgreSQL `014_creator_identity.sql` / SQLite `015_creator_identity.sql` are additive. Previous migration files/checksums are unchanged.

- `users.platform_role`: constrained `listener` (default), `moderator`, `admin`. Only registered accounts can hold staff roles. Creator access is **orthogonal**, derived from the profile's current `active` status, not a new login type or a client/session role claim.
- `creator_profiles`: one row per account UUID, bounded display name (1–80 Unicode characters) and bio (0–1000), `active/inactive/suspended`, created/updated timestamps. A composite FK to `(users.id, users.kind)` with constrained `account_kind='registered'` prevents guest/legacy profiles and unsafe account-kind downgrades. Deleting the account cascades its profile unless owned stories prevent it; there is no account-deletion endpoint.
- `stories.owner_id` references the creator profile; `ownership_kind` is system/external/creator. A cross-column check requires an owner exactly when kind is creator. Creator deletion is restricted while owning stories. Indexes cover creator status and story ownership. Existing provider metadata is retained and backfilled to external ownership; other existing stories remain system-owned.

The existing cookie/session/CSRF/Origin/account-change checks are reused. Services read roles/status from the database on every authorization decision. The public request body never supplies the principal, role, owner, provenance or status. `authorizationService` denies anonymous/guest access, checks active creator status, requires exact creator ownership and does not give staff an editing bypass. Missing/foreign/system/provider resources return the same 404 from the owned-story check. Staff permissions require an explicit server-owned allowlist, with no automatic admin-to-moderator inheritance. No public staff routes exist yet.

Creator writes, operator status changes and future owned-story checks lock the account first in a transaction (SQLite uses the existing serialized adapter). This serializes onboarding and suspension so there is one profile and suspension cannot be bypassed by a racing activation/edit. **Future protected writes must wrap authorization and mutation in the same outer transaction**, using the existing nested transaction convention; checking ownership and later opening another transaction would leave a race. Profile edits themselves currently use serialized last-accepted-write semantics, not edit revisions.

`storySelect`, catalog/chapter lookups, history, playlist eligibility and both stream routes exclude creator-owned entries. Public story serializers omit owner fields; catalog metadata caches remain public-only. System WAV scan jobs also skip creator-owned chapters. Startup seed upserts skip creator/provider parents and preserve chapter ID collisions; LibriVox imports reject creator ownership before even the unchanged-hash shortcut. No public mechanism changes ownership or makes creator content visible. This is a fail-closed prerequisite, not a publishing workflow.

## REST contract

All paths start with `/api`; all require a session and return private/no-store JSON. Mutations require the existing CSRF header. Query parameters and unknown fields are rejected. Public roles/owner/status setters do not exist.

| Method | Path                  | Body / result                                                                                                                                                                                                                                            |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/creator`            | `{eligible, platformRole, creator}`; guests get `eligible:false,creator:null`; `creator` is own profile or null                                                                                                                                          |
| POST   | `/creator`            | `{displayName,bio}`; registered-only explicit activation. First call creates active profile. Duplicate active call returns existing profile without overwriting fields/timestamps. Inactive call reactivates the retained profile. Suspended calls fail. |
| PUT    | `/creator`            | `{displayName,bio}`; only the active profile owner can edit; role/status/owner fields rejected                                                                                                                                                           |
| POST   | `/creator/deactivate` | `{}`; registered-only soft deactivation. Repeat inactive request is effect-free. Suspended profiles cannot convert to inactive to evade suspension. No profile returns 404.                                                                              |

Success responses use the GET shape. Creator profile fields are `displayName,bio,status,createdAt,updatedAt`; internal owner/account-kind columns are not exposed. Names/bios are trimmed; names reject control characters; bios allow newline/tab but reject unsafe controls. JSON body size is already bounded by Express. Invalid input is 400 `INVALID_CREATOR_REQUEST`; anonymous 401; guest/legacy or inactive permissions 403; suspended activation/deactivation 403 `CREATOR_SUSPENDED`; generic missing resource 404; stale account header 409 without another account's data. Existing general API rate limits apply; Redis outages fail closed for private APIs, while public media policy is unchanged.

## Operator provisioning

No staff bootstrap is needed for ordinary creator activation. Staff roles and suspension use a separate, explicit trusted CLI:

```bash
# Set DATABASE_URL securely in the operator environment, then:
npm run identity:provision -- role ACCOUNT_UUID moderator --confirm-operator
npm run identity:provision -- status ACCOUNT_UUID suspended --confirm-operator
npm run identity:provision -- status ACCOUNT_UUID active --confirm-operator
npm run identity:provision -- role ACCOUNT_UUID listener --confirm-operator
```

Role values: listener/moderator/admin. Status values: active/inactive/suspended; status requires an existing creator profile. The CLI validates arguments before connecting, requires an explicitly selected database, loads **no dotenv**, and uses existing normal startup migrations/seed guards. SQLite requires both `DATABASE_DRIVER=sqlite` and an explicit `DATABASE_PATH`. These commands are documentation, not operations performed on developer/production accounts in this milestone. There is no first-user administrator, shared demo privilege, HTTP operator token or generic administrative endpoint. Durable moderation/audit workflows remain M2.7 work.

## Import, backup and rollout

Backups now fingerprint **22 tables**, including creator profiles and user roles/story owner columns. Restore verification accepts the allowlisted earlier 21-table manifest shape as well as the new inventory; no arbitrary manifest table names are interpolated. The new full-inventory restore is tested with populated suspended creator, staff role and owned story. A legacy-inventory manifest compatibility exercise is not a historical pre-M2 archive drill.

SQLite import reads creator profiles before owned stories. New source identity/role/status is preserved; existing target user roles, creator fields and suspension are never overwritten. Conflicting story owner/provenance or chapter parent IDs abort the complete import transaction. This is an operator-trusted database import, not a public user-controlled file upload or cross-account merge API.

Roll out migrations before new binaries and drain old seed/import writers before introducing any creator-owned rows. Old code does not enforce ownership. Creator content remains invisible until a later, verified publishing boundary exists. Before restoring an old backup, follow the existing M1.5 revision/retired-writer recovery policy; applying migrations does not make old progress revisions current.

## UI, verification and remaining limits

`/creator` reuses account-scoped requests and existing Settings styling. It displays eligibility, role and status; supports activation, own name/bio editing and confirmed soft deactivation/reactivation; suspended profiles are read-only with explicit refresh. Late reads/mutations are aborted/discarded on account/session changes. Aborting cannot undo a mutation already accepted for the old owner. Playback continues during profile/status changes. Creator profile metadata is private and never enters PWA caches. Management is online-only.

Local verification: **355 application tests passed** (221 backend + 134 frontend; zero failures/skips), **6 CI safety tests**, and **114 browser check groups**, including eight Creator checks per database. Clean Node 22 installation, production build, formatting and local CI-equivalent runner gates passed. Exact local test/build/browser/CI results are recorded in [m2-creator-identity-verification.json](m2-creator-identity-verification.json). **Remote GitHub Actions remains NOT RUN / NOT VERIFIED.** Local Chrome coverage is not cross-browser certification. No production/developer data changes, push or deployment is included.

Remaining limits: automatic onboarding is not identity/licensing verification; no approval queue, durable operator audit log, public creator pages, Studio CRUD, uploads, media processing for creators, publishing or moderation UI. Account sessions stay valid during creator suspension, intentionally preserving listener access. UI status refresh is explicit; backend authorization is always current. Staff permissions are primitives for future routes, not implemented moderation capabilities. No production-scale performance/security claims are made.

Recommended M2.2: private draft story/chapter CRUD only, with server-generated stable IDs and immutable current creator ownership, optimistic edit revisions, bounded owner lists and strict public/draft separation. Test cross-owner access, stale edits, ordering/collisions, rollback, seeding/import preservation and suspension races before adding uploads or publishing.
