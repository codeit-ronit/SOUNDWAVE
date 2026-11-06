# SoundWave architecture

The existing modular monolith includes PostgreSQL/session isolation, Redis protection/cache-aside, BullMQ media processing, a PostgreSQL analytics/email outbox, and backup/restore tooling. React/Vite, Express, streaming and explicit offline downloads are preserved. Uploads, transcoding and CDN delivery are not implemented. [Operations](OPERATIONS.md) explains the current runtime and failure behavior; [current claim verification](RESUME_CLAIM_VERIFICATION.md) records the latest tests and HTTP measurements; Phase 2 is historical.

## Request flow and ownership

```mermaid
flowchart LR
  UI[React + shared audio player] -->|Cookie + CSRF token| API[Express routes and validation]
  API --> Redis[Redis atomic limits + optional public cache]
  API --> Auth[Identity middleware]
  Auth --> Sessions[(Hashed sessions)]
  API --> Services[Auth, discovery and analytics services]
  Services --> Repos[Identity, catalog, listening and analytics repositories]
  Repos --> Adapter[Async database adapter]
  Adapter --> PG[(PostgreSQL)]
  PG --> Jobs[Transactional job outbox]
  Jobs --> Worker[Worker: leases + retries + fencing]
  Worker --> SMTP[Configured SMTP / local mail catcher]
  Redis --> Media[BullMQ media queue]
  Media --> Worker
  Worker --> Derived[(chapter_media metadata + waveform)]
  Adapter --> SQLite[(SQLite compatibility)]
  UI --> SW[Service worker]
  SW --> Cache[Public chapter metadata + selected audio]
```

The cookie determines identity. Each private operation uses `req.user.id` resolved from the session table. No request body, query string or forwarding header selects the owner. Public catalog and media reads work without a session; favorite flags and chapter positions reflect only the current identity, or neutral values when anonymous. Library, progress and analytics require an authenticated registered or guest session.

`X-Session-User` is a stale-tab guard, not an authorization credential: it can only reject a request whose asserted account differs from the server-resolved session. CSRF tokens also bind queued player writes to the session that created them. A player mounted for an old account cannot obtain a new session's token through the mutable global client scope. Account changes remount player/library state. BroadcastChannel tells other tabs to reload, with a sender identifier preventing self-reload.

Legacy contract tests inject identity and CSRF middleware in `server/test/helpers.js` to preserve the original endpoint assertions. This is constructor-level test dependency injection, not a runtime environment switch, HTTP header or public authentication bypass. Separate auth tests and browser checks use the real middleware on both adapters.

## Authentication design

- Registration validates an email, a name of 1–80 characters, and a password of at least 12 characters and at most 256 UTF-8 bytes. Emails are normalized to lowercase and uniquely constrained.
- Passwords use Node's asynchronous **scrypt**, `N=131072`, `r=8`, `p=1`, a random 128-bit salt and a 64-byte derived key. Cost parameters are fixed and checked on verification; comparisons use `timingSafeEqual`. Unknown users still perform a derivation. At most two derivations run per Node process to bound memory use; excess work returns 503. This is a reputable password-hashing alternative, not Argon2id.
- Session tokens contain 256 random bits. Only SHA-256 token hashes are stored in the database; passwords, raw session cookies and request bodies are not logged by request logging.
- Production cookies use `__Host-soundwave`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain, and a bounded expiry. Local HTTP uses `soundwave-session` without Secure. Production startup requires an exact HTTPS `APP_ORIGIN`.
- Expiration is checked against the database on every session lookup. Registered sessions default to seven days, guests to one day, and pre-login anonymous sessions to ten minutes. There is no sliding renewal. Login, registration and guest creation rotate the session and CSRF token. Logout deletes the database row and expires the cookie.
- `/api/auth/session` issues a pre-login session and exposes only its CSRF token, sanitized profile, expiry and demo availability. Every unsafe request, including registration/login/logout, needs the corresponding `X-CSRF-Token`; untrusted Origin and cross-site Fetch Metadata values are rejected. Production trusts only `APP_ORIGIN`. Local development also permits the configured dev frontend defaults and the server's actual same-origin URL.
- General API limits remain 300/IP/minute, with audio exempt. Authentication writes have a separate 15/IP/15-minute limit. Counters are shared when Redis is configured and process-local otherwise; auth email/account buckets also limit targeted attempts. Only configured proxy CIDRs are trusted. No bot challenge or production anti-abuse certification is implemented.

These choices follow [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) guidance. They have regression coverage, not a penetration-test or production-security certification.

## Google identity extension

`GOOGLE_CLIENT_ID` enables the official Google Identity Services button. A session-bound, hashed nonce expires after five minutes and is consumed transactionally with identity resolution and session rotation. JOSE verifies RS256 signatures against Google’s HTTPS JWKS, issuer, configured audience, expiry, issued-at time, authorized party when present, verified email and nonce. Token/key fetch failures fail closed; no Google credential is persisted.

Additive PostgreSQL migration 008 and SQLite migration 009 introduce `oauth_identities` (unique provider/subject and user/provider, cascading owner FK) and `oauth_challenges` (session FK and expiry index). Unknown subjects upgrade guests in place; known subjects resolve their existing owner. Email collisions require password login followed by explicit linking. Google-only users have a deliberately invalid password marker to preserve the existing SQLite registered-user constraint; password login/reset cannot turn that marker into credentials. Gmail/verified Workspace identities can establish application email verification; third-party addresses do not.

Account recovery, concurrency, revoked-session races and authorization are covered on both database adapters. See [Google implementation and evidence](GOOGLE_SIGN_IN.md); real-user provider completion is distinguished from signed local JWT fixtures.

## Demo accounts and preservation

The frontend automatically exchanges an anonymous CSRF session for an isolated guest when demo mode is enabled. Guests can use the same player, library, recommendations and analytics, with an independently generated owner UUID. `DEMO_MODE=false` disables this exchange; it does not grant a fallback identity.

Registering while a guest upgrades that guest row transactionally, retaining its ID and owned records. Logging into an existing account switches identities and does not merge unrelated guest data. The previous shared `demo-user` is retained as an unclaimable `legacy` identity: neither authentication nor the demo endpoint can sign into it. Preserving legacy data does not make it every visitor's personal history.

## Database and transactions

PostgreSQL is the default and requires `DATABASE_URL`. SQLite must be explicitly selected for compatibility. `pg` supplies a bounded pool with connection, statement and lock timeouts. Its transactions pin one checked-out connection using AsyncLocalStorage; COMMIT/ROLLBACK always releases that connection. No transaction uses unrelated pool queries. See [node-postgres transactions](https://node-postgres.com/features/transactions).

The small adapter binds application-owned `?` and `@name` placeholders to PostgreSQL `$n` parameters, skipping quoted literals; values are transmitted separately. Sort expressions come from a fixed allowlist. Dialect-specific current-time, UTC-date and event-order expressions live in the adapter. This is a bounded internal query interface, not an arbitrary SQL translator or ORM. Prepared SQL/repositories remain directly readable.

SQLite remains available for development and existing data. Its async compatibility adapter serializes operations and holds `BEGIN IMMEDIATE` through async transactions, so requests cannot interleave inside another request's write transaction. The original synchronous SQLite handle remains usable for test fixtures and old local tooling.

| Relation                  | Identity, constraints and indexing                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                   | Text PK; unique lowercase email; registered/guest/legacy kind; registered accounts require a password hash and email                                                                       |
| `sessions`                | Hashed-token PK; nullable user FK for pre-login sessions; user and expiry indexes; CSRF token and expiry                                                                                   |
| `stories`                 | Catalog PK, required metadata; PostgreSQL genre index                                                                                                                                      |
| `chapters`                | Story FK; unique story/chapter number and story/id; positive duration                                                                                                                      |
| `favorites`               | Composite owner/story PK and FKs; owner/recency index                                                                                                                                      |
| `listening_progress`      | Composite owner/chapter PK and FKs; nonnegative finite position; completion constraint; recency index                                                                                      |
| `progress_write_versions` | Composite owner/chapter/client PK; positive safe integer sequence                                                                                                                          |
| `listening_events`        | Composite owner/event PK; owner, story and chapter FKs; story/chapter relationship FK; type/duration/JSON constraints; user/time and user/story indexes; monotonic event-order tie-breaker |
| `schema_migrations`       | Version PK, SHA-256 checksum and application time                                                                                                                                          |

Favorite additions and their events commit together. Progress changes, ordering versions and completion events commit together. PostgreSQL progress transactions use an owner/chapter advisory lock so concurrent first completions create one transition event. A conditional version upsert ignores stale same-client snapshots. Different clients remain last-arriving writers; this is not general conflict resolution.

Event idempotency is scoped to `(user_id,event_id)`. Identical retries do not add time; conflicting payloads return 409, including a post-insert comparison covering simultaneous conflicting requests. The same event UUID from two owners never exposes or suppresses another owner's event.

Migrations are ordered SQL files, checksum-checked and transactional. PostgreSQL migration runners serialize through a database advisory lock. SQLite adds auth and ownership guards without erasing existing rows; it retains the pre-migration event table as `legacy_listening_events_v0` while copying rows into the new owner-keyed event table. This archival table intentionally consumes disk until an operator reviews retention. No automatic down migrations or table-dropping reset command is provided.

The explicit SQLite importer reads one source snapshot in read-only mode and inserts into PostgreSQL in one transaction. It preserves owner IDs and timestamps, skips existing target keys, does not copy sessions, and never writes the source file. Existing conflicting target data is not overwritten. Review counts and reconcile conflicts before treating an import as a complete cutover. Catalog seeding remains idempotent and preserves listener rows.

## Browser storage boundary

Session profiles, CSRF responses, libraries, progress and analytics are not put into Cache Storage. API responses use private/no-store and Vary: Cookie. The new worker drops the old general JSON cache; it performs network reads and only falls back to explicitly stored public metadata.

Selected downloads retain public catalog metadata with favorite/progress/completion/identity fields removed or reset. Audio is public catalog content, so downloads are intentionally device-wide across account changes. They are not private licensed media. Server-side authorization would not protect content already stored on a device; private entitlement-based downloads are outside Phase 1.

The shell, downloads, range seeking, cache removal and quota failure behavior remain covered. There is no offline auth or private-data sync queue. An offline reload permits downloaded playback with neutral metadata, not a restored authenticated session.

## Deployment and operations

Use a persistent PostgreSQL service, verified database TLS where needed, HTTPS at the app origin, backups and a trusted reverse proxy. Size the connection budget as instances × pool max; no benchmark supports a scaling claim yet. Runtime migrations are convenient here; larger migrations should become a controlled release step with an appropriately privileged migration role and a restricted app role.

Compose supplies PostgreSQL and a non-root Node app with a named database volume. Startup retries only transient database-connectivity failures with bounded backoff; schema/checksum/configuration failures are not retried. PostgreSQL restarts unless stopped; the app has an on-failure policy capped at five restarts. A simultaneous container restart exposed and verified the fix for a database-readiness race. Explicit API/worker Docker targets now include readiness/heartbeat probes; the media-enabled worker probe also checks Redis connectivity and public worker-running state. Its default localhost HTTP mode explicitly uses development cookies. For public hosting set `APP_NODE_ENV=production`, set an HTTPS `APP_ORIGIN`, and terminate TLS before exposing the app. Do not run a public deployment in development mode.

The current public frontend runs on Vercel and proxies API/audio to the Docker-built Render service. Neon PostgreSQL 18 is authoritative; private Render Key Value supplies Redis-compatible caching/limits/BullMQ. The free demo runs the existing API and worker as separately supervised child processes in one web-service container. A child crash stops its sibling; platform restart restores the service. Both sleep when Render is idle. Free Redis does not persist queue/counter/cache state; PostgreSQL user data, analytics/outbox and media results persist. Normal Compose keeps separate containers and Redis AOF. [Public deployment verification](PUBLIC_DEPLOYMENT.md) records actual HTTPS, auth, PWA, media and restart checks. The old ephemeral Vercel API is excluded from the frontend deployment.

Implemented operations now include shared throttling, expiry/guest cleanup, verification/reset emails and local backup/restore drills. Remaining hosting work includes continuous durable worker/Redis hosting, external SMTP deliverability, MFA, account deletion, security/CSP review, offsite/encrypted/scheduled backups, recovery promotion, database role separation, telemetry, load tests and cross-browser/device coverage.

**Redis implemented:** atomic TTL counters are shared across API instances. During a configured outage, auth/private operations fail closed, while public catalog/discovery reads use PostgreSQL and bounded per-process fallback; audio is exempt. Cache-aside stores neutral catalog/search/genre data, with current-owner overlays and transactionally changed revision keys. It uses 128 slots/revision, 60-second TTLs and hit/miss/error/write counters. See [Operations](OPERATIONS.md#redis-limits-and-catalog-cache).

**Two job backends with distinct responsibilities:** BullMQ/Redis owns media work; the existing PostgreSQL outbox preserves analytics/email writes and prior jobs. One supervised worker process runs both. The outbox uses `SKIP LOCKED`, lease fencing, retry/backoff and dead letters. BullMQ uses its native locking/retry/stalled recovery. There is no claim that existing analytics jobs were migrated to Redis. Synchronous progress acknowledgements remain synchronous.

**Media implementation:** producers hash catalog-owned WAV bytes and submit content-versioned BullMQ IDs. Workers safely resolve the catalog mapping, analyze bounded 16-bit PCM chunks and calculate actual format, duration, RMS and 128 waveform peaks. A versioned `chapter_media` FK table stores one result per chapter. Conditional transactional upserts make replay idempotent; unsupported/missing media is visible as failed work. The metadata API serves DB results while streaming continues. It supports the existing immutable WAV catalog, not arbitrary uploads or transcoding.

**Failure and performance evidence:** actual hard worker termination recovers through a second process; Redis stop/start retains public reads and restores the cache/SQL session flow. A real HTTP benchmark checks complete response consistency and records latency, throughput and cache ratios on six original stories and a 1,000-story generated fixture. [The report](RESUME_CLAIM_VERIFICATION.md) explains why this supports implemented architecture patterns but not production-scale guarantees.

**Email and restore:** one-use tokens, encrypted SMTP jobs, session revocation and fragment-token forms remain tested through actual local SMTP capture and Chrome. Backups share an exported PostgreSQL snapshot with a manifest and restore only into a generated disposable database. Current coverage includes 18 tables, including source metadata and the Google identity/challenge tables. Neither public email deliverability nor managed disaster recovery is certified.

See [OPERATIONS.md](OPERATIONS.md) for exact commands, privileges, retention, Redis durability and media limits.

## External catalog extension

[The LibriVox integration](LIBRIVOX_INTEGRATION.md) adds normalized `story_sources` / `chapter_sources` tables in additive migrations. The existing BullMQ worker imports a fixed, reviewed list of ten projects. Provider calls have bounded bodies/timeouts and strict host/path/provenance validation. Imports are transactional, idempotent and retain listener state; new content changes the catalog revision. No provider fetch is performed during catalog/discovery reads.

The streaming route resolves public chapter IDs through the database, validates single ranges against stored size and redirects approved MP3 GETs to Archive.org. Thus the browser gets audio directly from the provider; the free API is not a bandwidth proxy. HEAD describes stored metadata. Existing WAV conditional streaming/analysis remains. External metadata is explicitly provider data, not generated waveform analysis. MP3/WAV offline downloads preserve MIME and neutral provenance, with 25 MB/chapter and 200 MB/device caps.
