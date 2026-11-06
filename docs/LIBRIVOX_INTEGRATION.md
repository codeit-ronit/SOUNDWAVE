# Curated external audiobook integration

Implemented on **6 November 2026**, runtime commit `188539f`. The integration adds real human-narrated content while retaining all six bundled SoundWave stories. The existing artwork/layout is retained; imported books are labelled LibriVox and include narrator/source credits rather than being presented as SoundWave Originals.

## Content and provenance

The approved catalog is version-controlled in `server/catalog/curated.json`: Alice's Adventures in Wonderland, Adventures of Sherlock Holmes, Frankenstein, Dracula, Treasure Island, Pride and Prejudice, Time Machine, Wonderful Wizard of Oz, Secret Garden and Jungle Book.

Actual source responses produced **10 books and 212 chapters**, plus the existing **6 stories / 12 chapters**: **16 titles and 224 chapters in total**. Book/chapter descriptions, author names, narrators, track IDs and durations come from the [LibriVox API](https://librivox.org/api/info). Internet Archive item metadata confirms the `librivoxaudio` collection, approved archive identifier, exact MP3 filenames, sizes and MD5 metadata. LibriVox's [public-domain policy](https://librivox.org/pages/public-domain/) states its recordings are public domain in the USA and advises checking other jurisdictions. Source links and the USA qualification remain visible. These are classic audiobooks, not licensed Pocket FM content.

No new dependency, API key, paid service, AI narration or LLM API is required. No book audio is committed to this repository or downloaded onto the API host. Source artwork is not imported; the existing vector covers display the book title and provider label.

## How it works

1. With `LIBRIVOX_CATALOG=true`, the existing supervised media worker schedules the ten approved projects in BullMQ. Jobs are spaced 2.5 seconds apart, use four attempts and exponential backoff, and are visible through `npm run media -- list`.
2. The importer fetches only fixed LibriVox/Archive endpoints, with twenty-second timeouts, bounded JSON bodies, strict identifiers/filenames/hosts and provenance checks. Invalid/incomplete source data is rejected; there is no public URL-fetch or import endpoint.
3. Complete book imports commit in one transaction. Stable provider track IDs map to stable chapter IDs. Concurrent PostgreSQL imports use an advisory lock. Reimporting unchanged content preserves user state and the cache revision. Changed metadata advances the revision in the same transaction. Existing ID collisions and changes to an already published chapter order require operator review; imports do not erase history or overwrite unrelated catalog rows.
4. PostgreSQL serves normal catalog/search/discovery requests; Redis cache-aside remains in use. Browsing never waits for a live LibriVox API call. Imported metadata remains available if a provider goes down.
5. Audio GET resolves a chapter through the database and returns **307** to its validated `https://archive.org/download/...mp3` URL. The browser follows Archive's CDN redirects and receives audio bytes directly. This avoids carrying large audio downloads through free Render/Vercel hosting. Valid ranges are delegated; malformed/multiple/unsatisfiable ranges are rejected locally with 416 using known file size. HEAD describes the known source representation with MPEG content type and full length. It does not independently prove upstream availability; real GET probes do.
6. External `/metadata` responses explicitly say `source-metadata` and have no waveform. Provider durations are not represented as locally measured MP3 analysis. The existing WAV analysis workflow continues for the twelve bundled files and excludes external chapters.

PostgreSQL migration `007_external_catalog.sql` and SQLite migration `008_external_catalog.sql` add `story_sources` and `chapter_sources`, FKs, uniqueness/check constraints and a refresh index. Backup fingerprints now cover **16** tables. The optional read-only SQLite importer preserves source mappings too.

## Offline downloads

The browser supports WAV and MP3 downloads, requiring a complete 200 response, bounded Content-Length and a valid basic audio signature. Downloaded bytes must match the length. This is not a cryptographic verification of the provider's MD5 or arbitrary-codec validation. Chrome successfully decoded the tested MP3.

Downloads remain explicit: **25 MB per chapter and 200 MB total per browser**. One download runs at a time. Oversized chapters are labelled **Stream only**; six of the selected chapters exceed the offline cap. Quota, truncated/partial responses, invalid data and budget errors do not advertise a completed download. Requests are cancelled on failure or after a five-minute deadline. The service worker preserves the cached audio MIME type when serving offline 206 ranges. Attribution/public metadata is cached with neutral favorites/progress; private identity and analytics are not stored in the PWA cache.

## Setup and operations

Compose and `.env.example` enable the catalog. Host-side development needs PostgreSQL, Redis and `npm run worker`; set `LIBRIVOX_CATALOG=true`. Without Redis/the media worker, the six bundled stories still work and no fake imported titles are shown. First-time books appear as their background jobs commit. Successfully imported books are checked for refresh after seven days when the worker is awake.

```bash
npm run worker
# Operator commands, with the configured database and Redis:
npm run catalog:import                # enqueue missing/stale approved projects
npm run catalog:import -- --refresh   # explicit refresh, preserving user state
npm run media -- list
npm run media -- retry librivox-PROJECT_ID-DATE
```

Retries do not mean unlimited provider polling. Failed daily job IDs remain visible; automatic retry of an unimported project can be scheduled the next day. `--refresh` creates an explicit operator job. No visitor can submit arbitrary projects or URLs. Free hosted Redis can lose its jobs on restart, but the scheduler can reconstruct missing work from PostgreSQL; this is not durable hosted Redis delivery.

## Executed verification

- **106 backend + 27 frontend = 133 tests passed**, zero failures/skips, with real PostgreSQL, Redis, BullMQ and backup tools enabled. New tests cover import transactions/idempotence, stable identities/ordering, partial-batch rejection, catalog ID collision preservation, upstream failures, allowlisted URLs, ownership/progress, cache invalidation, queue retries, MIME/size validation and MPEG admission.
- Production frontend build: **PASS**, 1,701 modules. Docker image build: **PASS**. Its API health probe now respects the runtime `PORT`, including Render's port override.
- Existing browser/player/library/search/analytics checks: **14 PASS**.
- Existing PWA/download/range/quota checks: **13 PASS**.
- Existing separate-process PostgreSQL/Redis/SMTP/auth/analytics checks: **7 PASS**.
- Real-provider scenario: **6 PASS**, [actual results](catalog-live-results.json). An actual BullMQ worker imported all ten books and processed twelve WAVs (**22 completed jobs, 0 failed**). The first chapter of every book returned real 100-byte 206 responses. Chrome decoded an external MP3, restored paused progress, downloaded it across origins, reloaded/played/seeks offline and removed it. A size-header fixture exercised the 200 MB admission limit without allocating 200 MB.

Reproduce with disposable local services (the script creates/removes a PostgreSQL schema and its queue namespace):

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 \
TEST_BACKUP_CONTAINER=YOUR_MATCHING_POSTGRES_CONTAINER npm test

TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 \
npm run test:catalog:live -- docs/catalog-live-results.json
```

The backup source must be migrated before the full backup/restore suite. Optional service tests do not run without their environment variables. Live provider/browser checks are opt-in, not part of a deterministic offline unit suite.

Real testing exposed zero-based introduction numbering; normalization and a regression test fixed it. An existing one-second Redis TTL test assumed the host/container clocks advanced identically; it now verifies Redis's actual TTL and observed expiry. One additional exploratory archive range probe was reset by the remote connection; bounded probe retries now record such attempts. The recorded final six-check run needed zero range-probe retries. Runtime player/download errors remain visible and retryable by the visitor; provider availability is not guaranteed.

The recorded local browser took **5,149 ms from click until audio had advanced past one second**, one observation including real playback and external CDN/network time. It is not a pure startup measurement, before/after benchmark or production SLA. The small live scenario recorded one Redis hit/two misses during its catalog/chapter requests; it is not a representative traffic hit ratio. Earlier synthetic HTTP cache measurements remain separately qualified in [RESUME_CLAIM_VERIFICATION.md](RESUME_CLAIM_VERIFICATION.md).

## Public rollout

The current release is publicly verified at **https://soundwave-codeit-ronit.vercel.app/**. The submitted **https://zippy-nitrogen-wd3scr3.tmp.now/** URL still redirects to it. Try [Alice’s Adventures in Wonderland](https://soundwave-codeit-ronit.vercel.app/stories/1200).

- Vercel frontend deployment `dpl_6bQVo256jogtcgW8UKTds6Jwzd2T` was staged, checked, then promoted. Render deployment `dep-dbmvc25bedkc73djqsvg` built and ran commit `188539f`. The free service's `LIBRIVOX_CATALOG` flag is enabled.
- Hosted PostgreSQL was queried directly: **10 source books, 212 source chapters, 224 total chapters and 12 original analyzed WAVs**. The hosted worker produced the external data; no host-side import wrote the public catalog.
- `node scripts/public-catalog-smoke.mjs docs/public-catalog-results.json`: **5 PASS** on the real public URL — full catalog/provenance, external ranges/HEAD, Chrome playback/seek/favorites/refresh resume, offline MP3 download/play/ranges/removal and mobile viewport layout. [Actual public observations](public-catalog-results.json).
- `node scripts/public-backend-smoke.mjs https://soundwave-codeit-ronit.vercel.app`: **9 PASS** after the release — original WAV playback, registration/login/logout, owner isolation, secure cookies/CSRF and the existing PWA flow.
- A real `render restart` retained all ten imported books and 212 chapters, and an exact snapshot of the identified external-listener fixture's favorites, chapter position and analytics events matched afterward. The public book API still returned the credited book. Identified test account/guest data was then cleaned up.

Five sequential public catalog requests, fully read from the developer machine, took **1,123 / 492 / 1,379 / 531 / 378 ms** (median **531 ms**, zero HTTP errors). These are small network observations during other smoke checks, not a load/capacity test or before/after comparison. The public MP3 observation took **9,602 ms from click until audio passed one second**. A ten-second seek produced only **1.401 seconds** of recorded actual listening in that test. External CDN/network time and free-host scheduling vary; no instant-start promise is made.

## Limits

Browsing uses local persistence/cache; new-source audio startup and availability depend on Internet Archive/CDN redirects. Larger tracks take longer to download. Render's idle wake-up and sleeping worker limits remain. All 212 chapter mappings/sizes were validated against provider metadata; the first chapter of each book and the Alice MP3/offline flow were checked with actual bytes. Every chapter has not been listened through end to end. External conditional-range behavior, all browsers/mobile hardware and long-duration traffic were not established.

Keep the new streaming-capable runtime when operating a database with published external books; an older WAV-only runtime cannot play their mappings. Source changes that remove/reorder published chapters require operator review and retain the previous catalog. No upload/transcoding pipeline, entitlement system or automatic external artwork import was added.
