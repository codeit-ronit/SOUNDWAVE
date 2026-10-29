# SoundWave

**Stories worth getting lost in.** A working audio fiction platform built with React, Vite, Express, and SQLite. Discover original stories, save a personal library, and resume a chapter across refreshes with server-persisted playback state.

Built as a product-focused software engineering portfolio project. This is a single-listener demo, with no claims about real users or production-scale performance.

**Live demo:** [soundwave-codeit-ronit.vercel.app](https://soundwave-codeit-ronit.vercel.app) · [Source](https://github.com/codeit-ronit/SOUNDWAVE) · [Independent audit](FINAL_AUDIT.md)

The Vercel demo uses temporary SQLite storage; data can reset or differ between function instances. The normal Node server supports a persistent database path and has been tested across process restarts.

![SoundWave desktop interface](docs/soundwave-desktop.png)

## Run locally

Requires **Node.js 22.x and npm** (pinned for native SQLite runtime compatibility). The verified environment used Node 22.21.1. All twelve audio files are included; no external audio service, API key, or macOS speech tooling is needed to run the app.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on **http://127.0.0.1:3001**. Vite proxies `/api` and `/audio` to Express. SQLite initializes and seeds automatically on server startup. Stop both servers with Ctrl+C.

Optional configuration, read from the repository root:

```bash
cp .env.example .env
```

| Variable        | Default / purpose                                                                |
| --------------- | -------------------------------------------------------------------------------- |
| `PORT`          | `3001`; Express port                                                             |
| `CLIENT_ORIGIN` | Localhost and 127.0.0.1 on port 5173; comma-separated CORS origins               |
| `DATABASE_PATH` | `server/data/soundwave.sqlite`; use an absolute persistent-volume path on a host |

The Vite development proxy targets port 3001. If changing the API port for development, also update `client/vite.config.js`. Vite prints another port if 5173 is occupied; use the printed address and add it to `CLIENT_ORIGIN` when calling the API cross-origin.

**For the complete installable/offline experience**, run the production bundle with one server (service worker registration is intentionally disabled during Vite development):

```bash
npm run build
npm start
# Open http://127.0.0.1:3001
```

## Implemented product

- **Discovery:** six original stories across five genres, spotlight, story details, twelve ordered chapters, responsive cover artwork, and mobile navigation.
- **Persistent audio player:** one HTML5 audio element above the router's pages; play/pause, seeking, ±10 seconds, next/previous chapter, volume/mute, duration, buffering, and recoverable playback errors. Navigating between pages keeps playback running.
- **Advanced controls:** 0.75×, 1×, 1.25×, 1.5× and 2× playback speed with a device-local preference; 5/15/30-minute sleep timer with cancellation; Space to play/pause and arrow keys to seek when focus is outside interactive fields; animation-frame progress updates with cleanup.
- **Media delivery:** a dedicated disk-streaming endpoint with correct full, partial, unsatisfiable and HEAD responses.
- **PWA and downloads:** versioned app-shell caching, manifest/icons, native install affordance when the browser offers it, selected-chapter downloads, offline seeking, removal, storage errors, and offline status. No automatic catalog-wide audio downloads.
- **Listening insights:** SQLite events, measured playback intervals, seven-day listening chart, genre bars, completion/favorite totals and recent activity.
- **Reliability:** request IDs, optional structured request logging, a process-local JSON API rate limit, and indexes for event queries.
- **Listening history:** SQLite stores playback position, chapter completion, and last update time. Saves happen about every ten seconds of playback, on pause, seek, chapter changes, and completion, with best-effort keepalive saves when hiding/leaving the page. Continue Listening selects the next unfinished chapter after completion. Restored audio waits for the listener to press play.
- **Library:** add/remove favorites through idempotent REST operations; My Library survives a refresh and server restart. Saved stories influence recommendations.
- **Search:** backend title **or genre** search, exact genre filtering, and trending/title/newest sorting. Query state lives in the URL; search and filters combine. Search uses the header form (Enter or its submit control).
- **Personalization:** deterministic, rule-based recommendations from favorite genres and listening history. No LLM API, embeddings, model training, or inference service.
- **Feedback:** loading, empty, missing-resource, API, audio, and persistence error states with retry actions. Library mutations disable their controls while pending.

### A three-minute demo

1. Start a story from Discover. Navigate to its detail page while audio continues.
2. Seek or pause, refresh, and press play: the same chapter resumes at the saved position.
3. Finish chapter one or seek close to its end; chapter two starts automatically. Completed chapters are marked in the chapter list.
4. Heart a Mystery story, open My Library, and refresh. Discover now favors the other Mystery story in its recommendations.
5. Search `mystery`, sort by title, then try an unmatched search to show the empty state.
6. Set speed to 1.5×; refresh to show the preference survives. Set a sleep timer and cancel it. Use Space and arrow keys while focus is outside inputs.
7. In production mode, open a story, click **Save offline** for one chapter, open Downloads, disable the network in Chrome, and play/seek that chapter. Re-enable the network when finished.
8. Open **Insights** to see measured listening time, actual favorite/completion counts and recorded activity. Seeking toward the end does not add the skipped time.

## Architecture

```text
React + React Router + shared player/library/offline contexts
                    │ fetch /api/*
                    ▼
Express REST API ── better-sqlite3 ── SQLite (WAL + foreign keys)
       │
       ├── /api/chapters/:id/stream → bounded disk stream with HTTP ranges
       ├── /api/analytics/* → idempotent playback events and SQL aggregates
       ├── service worker → versioned shell + selected full audio cache
       ├── /audio/* → retained legacy static audio URLs
       └── production → client/dist + SPA deep-link fallback
```

```text
client/
  src/
    App.jsx                 Navigation and search
    pages.jsx               Discover, My Library, story details
    components.jsx          Cards, artwork, states, persistent player controls
    PlayerContext.jsx       Audio lifecycle, restore, autosave, transitions
    LibraryContext.jsx      Shared favorites state and mutation feedback
    OfflineContext.jsx      Registration, install prompt, verified selected downloads
    Downloads.jsx           Download controls, offline status and download library
    Analytics.jsx           Metrics, seven-day chart, genre bars and activity
  public/
    sw.js                   Shell/data caching and range-aware downloaded playback
    manifest.webmanifest    Install metadata and 192/512px icons
    api.js                  Centralized REST client
    playback.js             Resume selection and time formatting
    *.test.*                Player lifecycle and resume tests
server/
  app.js                    Testable Express app, CORS, static audio, SPA serving
  index.js                  Environment loading and server lifecycle
  db.js                     Relational schema, prepared statements, seed transaction
  routes/api.js             Validated REST endpoints and recommendation rules
  routes/stream.js          Secure file mapping, ranges, HEAD and streaming cleanup
  routes/analytics.js       Event validation, idempotency and SQL overview
  middleware/http.js        Request IDs, optional logs, JSON API rate limiting
  content/catalog.js        Original story metadata and narration scripts
  public/audio/             Twelve WAV files and measured duration manifest
  scripts/                  Idempotent seed and optional audio generation
  test/*.test.js            API, streaming, analytics and request-middleware tests
scripts/browser-smoke.mjs    Real production playback and analytics smoke scenario
scripts/offline-smoke.mjs    Speed, sleep, offline reload/play/seek and quota checks
```

The API uses prepared SQL statements. Sort expressions come exclusively from a fixed allowlist. Search escapes SQL wildcard characters to treat user input literally. SQLite foreign keys, composite unique keys, and check constraints enforce relationships and valid progress. Listener writes use the fixed `demo-user` identity. There is no client-provided user selector.

### Database schema

| Table                | Key and important columns                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `stories`            | `id` PK; title, genre, author, tagline, description, color, symbol, popularity                                          |
| `chapters`           | `id` PK; `story_id` FK → stories; chapter_number, title, audio_url, duration_seconds; unique (story_id, chapter_number) |
| `favorites`          | Composite PK (user_id, story_id); story_id FK → stories; created_at                                                     |
| `listening_progress` | Composite PK (user_id, chapter_id); chapter_id FK → chapters; position_seconds, completed, updated_at                   |

| `listening_events` | `event_id` TEXT PK; user_id, story_id FK, optional chapter_id FK, event_type, listening_seconds (0–60), metadata JSON, created_at |

Schema initialization is additive: it creates event and progress-ordering tables/indexes without deleting or rewriting existing progress and favorites. Event indexes support user/time and user/story queries.

Progress obtains its story identity through the chapter relationship rather than duplicating story IDs. Indexes support chapter lookup and listening recency. Times are UTC. Running `npm run seed` updates catalog content and preserves listener data. Runtime SQLite files are gitignored.

`progress_write_versions` uses the composite key `(user_id, chapter_id, client_id)` and stores the last sequence number. It rejects old or duplicate progress snapshots from the same browser tab, including delayed unload saves. Existing unversioned API clients remain compatible. Seek writes are coalesced for 400 ms; pause, chapter change, and page-hide saves flush immediately. Separate clients still share the demo user and can overwrite each other; this is not multi-user conflict resolution.

### Recommendation rules

1. Add **4 points per saved story** to that story's genre.
2. Add **2 points per distinct listened story** to its genre when it has positive progress or a completed chapter. Repeated playback updates and multiple chapters do not inflate this signal.
3. Exclude stories already in the library and fully completed stories.
4. Rank remaining stories by their genre score, then curated demo popularity, then ascending story ID. Return at most four, with a reason and score.

A new listener gets the curated popular catalog ordering. Popularity is seed metadata, not a fabricated real-world engagement metric. Equal input produces equal output. With six stories and five genres, matching candidates can be limited; popular fallback picks are expected.

### Media delivery

`GET /api/chapters/:id/stream` maps a validated chapter ID to its server-stored WAV path. It validates the mapping and resolved path, streams with `FileHandle.createReadStream`, and closes the stream on disconnect. No full audio file is read into a server-side Buffer.

- Full GET: **200**, `Content-Type: audio/wav`, exact `Content-Length`, `Accept-Ranges: bytes`.
- Single bounded (`bytes=0-99`), open-ended (`bytes=4000-`) and suffix (`bytes=-100`) ranges: **206**, exact `Content-Range` and range length. Oversized ends are clamped.
- Malformed, multiple and unsatisfiable ranges: **416**, `Content-Range: bytes */<size>`, zero-length body. Multipart ranges are deliberately unsupported.
- HEAD: **200**, full representation headers and no body. Range is ignored for HEAD, following GET-only Range semantics.
- Matching `If-Range` ETag/date enables ranges; stale validators return the full representation. ETag and Last-Modified are supplied.
- Existing chapter responses now provide streaming URLs. Original file mappings remain unchanged in SQLite; legacy `/audio` URLs still work.

### PWA and offline design

Build-time code injects the app shell's exact asset list and a content-derived cache version into the service worker. Activation deletes outdated SoundWave caches. The selected-audio cache is versioned separately to retain downloads across shell updates. Small successful JSON reads use network-first caching; mutations are never cached or queued.

Download is explicit, limited to 25 MB per file, and accepts **only a complete 200 WAV response** without Content-Range. It verifies Content-Length, actual byte length and RIFF/WAVE file size before storing the file. Chapter/story metadata is saved for offline selection. Storage estimates and quota errors are handled; a failed download is not advertised as available.

The service worker serves only selected full-file audio from Cache Storage, deriving **206 slices or 416 errors** for playback range requests. It never caches a 206 response as a full chapter. Unselected audio requires a connection. Downloads can be removed while offline. Browser eviction, clearing site data, or a different browser/device can remove or hide downloads.

Install UI uses the browser's native `beforeinstallprompt` event when available. Other browsers may offer installation through their own menu. HTTPS or localhost is required. Native OS installation and Safari behavior have not been tested; the manifest, worker and real offline playback have been verified in Chrome.

### Listening analytics

Events include `playback_started`, `playback_paused`, `chapter_completed`, `story_favorited`, and periodic `listening_interval` records. Native media listeners and stable refs prevent rerenders from generating duplicate starts. The player measures `performance.now()` intervals, flushes at save/pause/seek/buffering/transition boundaries, and excludes the distance jumped by a seek. Received intervals are bounded to 60 seconds; delayed background events can undercount rather than add arbitrary large durations.

The playback event endpoint accepts UUID idempotency keys: identical retries return 200 without another insert; conflicting key reuse returns 409. It derives story identity from the chapter, validates duration and supported playback speed, and timestamps on the server. Favorite additions and completion transitions generate events transactionally and only when the underlying state changes. No browser-rerender effect generates these server events.

`/api/analytics/overview` sums recorded intervals for listening time and genre charts, groups a seven-day UTC timeline, counts current completed progress rows and favorites, and returns the latest 20 events. Historical saved positions are never converted into listening time. These are client-observed demo metrics, not tamper-proof telemetry. Offline or failed event requests are not queued; only received intervals contribute. Offline views may show the last cached snapshot.

## REST API

All endpoints use `/api`. Every response includes `X-Request-ID`. Set `HTTP_LOG=1` for JSON request logs containing ID, method, path, status and duration (no request bodies). The JSON API allows 300 requests per IP per 60-second window per server process; excess requests return 429 and Retry-After. Audio streams are exempt. This demo limiter is not a distributed abuse-prevention system.

GET responses use `{ stories }`, `{ story }`, `{ chapters }`, or the shapes specified below. Errors consistently use `{ "error": { "message": "..." } }`.

| Method | Endpoint                           | Behavior                                                                                          |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/health`                          | Health, SQLite connectivity, demo user                                                            |
| GET    | `/genres`                          | `{ genres: string[] }`                                                                            |
| GET    | `/stories?q=&genre=&sort=trending` | `{ stories, total }`; `q` searches title or genre; genre exact and case-insensitive               |
| GET    | `/stories/:id`                     | Story metadata, chapter count, total duration, favorite flag                                      |
| GET    | `/stories/:id/chapters`            | Ordered chapters with saved position and completed state                                          |
| GET    | `/library`                         | Saved stories, newest favorites first                                                             |
| PUT    | `/library/:storyId`                | Add favorite idempotently; returns story, HTTP 200                                                |
| DELETE | `/library/:storyId`                | Remove favorite idempotently; HTTP 204                                                            |
| GET    | `/progress`                        | `{ progress, continueListening }`; latest progress first; one continue entry per unfinished story |
| PUT    | `/progress/:chapterId`             | Save `{ positionSeconds, completed?, clientId?, sequence? }`; returns `{ progress }`              |
| GET    | `/recommendations`                 | `{ strategy: "rule-based", stories }`; each story includes score and reason                       |

Additional endpoints:

| Method     | Endpoint               | Behavior                                                                                                            |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET / HEAD | `/chapters/:id/stream` | Full or byte-range audio, headers described above                                                                   |
| POST       | `/analytics/events`    | `{ id: UUID, type, chapterId, listeningSeconds?, playbackRate? }`; 201 new, 200 duplicate, 409 conflicting reuse    |
| GET        | `/analytics/overview`  | `{ totalListeningSeconds, completedChapters, favoriteStories, genres, dailyActivity, recentActivity, measurement }` |

Client-posted event types are `playback_started`, `playback_paused`, and `listening_interval`; favorites and completions are server-generated. Intervals must be finite numbers from 0 to 60; start events have zero duration. Rate must be one of the supported player speeds.

`sort` accepts `trending`, `title`, or `newest` (descending catalog ID). `q` is limited to 100 characters and `genre` to 40. Invalid IDs, repeated query values, invalid sorts, malformed JSON, unknown progress fields, and invalid positions return **400**. Unknown stories/chapters return **404**. JSON payloads are limited to 8 KB (**413**). Unexpected server failures return **500** without exposing internals.

The player supplies a UUID `clientId` and a positive integer `sequence` together. The server atomically ignores old/duplicate versions for that client/chapter. Omitting both preserves the original last-arriving-write API behavior.

`positionSeconds` must be a finite nonnegative JSON number within the chapter duration, with one second of tolerance for media metadata rounding. `completed` must be boolean; explicit completion requires a position within the final second. End positions are clamped and marked complete. Replaying a completed chapter saves a fresh position with `completed: false`.

```bash
curl 'http://127.0.0.1:3001/api/stories?q=mystery&sort=title'
curl -X PUT http://127.0.0.1:3001/api/library/1
curl -X PUT http://127.0.0.1:3001/api/progress/101 \
  -H 'Content-Type: application/json' \
  -d '{"positionSeconds":12.5,"completed":false}'
curl http://127.0.0.1:3001/api/progress
```

## Verification

```bash
npm test              # 40 HTTP integration + 20 client/player tests
npm run build         # production compilation and generated offline shell
npm run test:browser  # build + 14 real playback / analytics browser checks
npm run test:offline  # build + 13 advanced player / PWA / offline checks
npm run test:audit    # build + 7 independent restart/security/browser checks
npm run format:check
```

**Verified results:** **40 API tests + 20 client/player tests passed (60 total, zero failures)**. Production build passed. **14 core/analytics, 13 player/offline, and 7 independent restart/security checks passed (34 local smoke checks)** in headless Google Chrome. Existing playback, refresh restoration, favorites, recommendations, search and chapter transitions remain covered. All twelve original audio files still contain nonzero PCM and support HTTP byte ranges.

New API coverage includes exact full/range file bytes; bounded/open/suffix/clamped and invalid ranges; HEAD and If-Range; server path restrictions; event validation/idempotency/conflicts; interval-based metrics excluding seek positions; atomic favorite/completion events; request IDs, logs, 429 and media exemptions. Player tests verify speed persistence, timer expiry/cancel/cleanup, shortcuts and editable-field protection, rerender-safe events, and exclusion of buffering/seek time.

The browser scenarios verify native 206 audio playback, navigation/refresh persistence, analytics tied to real playback, speed after reload, keyboard controls, a five-minute sleep timer using an accelerated browser clock, app-shell reload with Chrome networking disabled, actual offline audio decoding, range-aware offline seeking, selective caching/removal, and simulated quota failure. Tests use temporary SQLite databases and isolated browser profiles. A regular isolated Chrome profile reports no installability errors. Native OS installation, physical mobile devices and Safari are not verified. Partial 206 downloads and truncated 200 downloads are fault-injected and rejected, without creating available audio entries.

The scripts use installed macOS Chrome if available, `CHROME_PATH` if supplied, or Playwright Chromium elsewhere. On a host without Chrome:

```bash
npx playwright install chromium
npm run test:browser
npm run test:offline
```

[Mobile screenshot](docs/soundwave-mobile.png) · [Analytics screenshot](docs/soundwave-analytics.png)

## Audio and artwork

The twelve short chapters (approximately 32–37 seconds each) are original fiction in `server/content/catalog.js`, narrated locally using the macOS Samantha speech voice. They are bundled as mono 22.05 kHz PCM WAV files, approximately 18 MB total. `manifest.json` records actual measured durations. They require no third-party streaming URL. Cover artwork is original CSS/vector composition using Lucide icons (ISC), without external images or proprietary branding.

Optional regeneration on macOS with the Samantha voice installed:

```bash
npm run audio:generate
npm run seed
```

The generator reuses existing WAV files; remove the specific generated file before regenerating an edited script. Normal setup never runs this macOS-only command.

## Deployment and limitations

**Public demo verified:** https://soundwave-codeit-ronit.vercel.app. The homepage, SPA deep links, REST API, HTTP HEAD, valid/invalid ranges, and actual Chrome audio playback have been checked over HTTPS. It is publicly accessible without Vercel login, as authorized by the owner.

The previously submitted `https://zippy-nitrogen-wd3scr3.tmp.now/` address is claimed and now uses a project-level, hostname-specific 307 redirect to the working demo. It was independently checked in a fresh Chrome session through actual audio playback. Retain that original claimed deployment and redirect because the submitted address depends on them. Prefer the stable branded URL in future submissions.

`vercel.json` builds the React client and routes API/audio requests to `api/index.js`, which uses a temporary `/tmp` SQLite database. **Durable public data persistence is not implemented on Vercel.** Local Node-server persistence is verified; that does not imply serverless persistence. Data may disappear on cold starts/redeploys or vary between instances. This is a portfolio demo, not a durable production service.

To redeploy the demo with the authenticated owner account:

```bash
npx vercel login
npx vercel link --yes --project zippy-nitrogen-wd3scr3 --scope ronit-choudharys-projects
npx vercel deploy --prod --yes
```

Use a remote Linux build for `better-sqlite3`. Uploading a Mac prebuilt function packages a Mach-O binary that fails on Linux; this failure was observed and repaired. Node 22.x is pinned in package metadata. `.vercel/` stays ignored. CLI deployment is configured; automatic deployment on GitHub pushes has not been configured or verified.

For deployment, use a Node-capable host with persistent disk, run `npm ci && npm run build` during the build, and `npm start` as the start command. Set `DATABASE_PATH` to a writable path on the persistent volume and allow the host to provide `PORT`. Express serves both the frontend and API from the same origin, including deep links. Include `server/public/audio` in the deployment. Static-only hosting cannot run the SQLite/Express API.

SQLite data on an ephemeral filesystem disappears on restart/redeploy; mount persistent storage before expecting saved progress to survive deployments. Use one application instance for this demo's local database. A serverless Worker host would require changing the requested server/database stack, so it was not used.

Scope limits:

- One shared `demo-user`, intentionally no authentication or per-visitor privacy. All clients pointed at a server share its library/history.
- A small seeded catalog, synthesized short narration, and simple LIKE search; no uploads, subscriptions, or production content pipeline. Offline audio is limited to explicitly selected chapters on one device.
- Rule-based recommendations over a tiny catalog; no claim of ML personalization or recommendation quality measurements.
- Pause/seek/transition saves are acknowledged by the API; unload/visibility saves are best effort. A crash or network failure can lose recent unsaved seconds. Errors are surfaced, with a retry action; there is no offline write queue. Concurrent tabs use last-arriving writes.
- No production authentication, distributed abuse controls, monitoring service, load benchmarks, or cross-browser certification. No real-user or performance-scale claims.

## Publish to GitHub

The repository is published at https://github.com/codeit-ronit/SOUNDWAVE. For a new clone or your own fork:

```bash
# If the checkout has not already been initialized:
git init -b main
git add .
git commit -m "Build SoundWave audio streaming demo"

# Replace the URL with your own empty repository:
git remote add origin https://github.com/YOUR_USERNAME/soundwave.git
git push -u origin main
```

Never add `.env`, SQLite runtime files, or credentials. The included `.gitignore` excludes them.

All four feature priorities are implemented. Remaining gaps are durable public hosting, native installation verification, and Safari/mobile hardware coverage. See [FINAL_AUDIT.md](FINAL_AUDIT.md) for the explicit PASS / FAIL / NOT VERIFIED assessment.

## Resume bullets

- Engineered an Express audio-streaming endpoint with disk-based byte ranges, HTTP 206/416 and HEAD support, validated file mappings, and integration tests for media-delivery edge cases.
- Extended a React audio player with persistent speed preferences, sleep timers and keyboard controls, and delivered a PWA with selective, verified audio downloads and range-aware offline playback.
- Built SQLite-backed listening analytics with idempotent events and interval-based metrics, verifying the platform with 60 automated tests and 34 local browser/process smoke checks.
