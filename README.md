# SoundWave

**Stories worth getting lost in.** A working audio fiction platform built with React, Vite, Express, and SQLite. Discover original stories, save a personal library, and resume a chapter across refreshes with server-persisted playback state.

Built as a product-focused software engineering portfolio project. This is a single-listener demo, with no claims about real users or production-scale performance.

![SoundWave desktop interface](docs/soundwave-desktop.png)

## Run locally

Requires **Node.js 22+ and npm**. The verified environment used Node 22.21.1. All twelve audio files are included; no external audio service, API key, or macOS speech tooling is needed to run the app.

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

To run the production bundle with one server:

```bash
npm run build
npm start
# Open http://127.0.0.1:3001
```

## Implemented product

- **Discovery:** six original stories across five genres, spotlight, story details, twelve ordered chapters, responsive cover artwork, and mobile navigation.
- **Persistent audio player:** one HTML5 audio element above the router's pages; play/pause, seeking, ±10 seconds, next/previous chapter, volume/mute, duration, buffering, and recoverable playback errors. Navigating between pages keeps playback running.
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

## Architecture

```text
React + React Router + shared player/library contexts
                    │ fetch /api/*
                    ▼
Express REST API ── better-sqlite3 ── SQLite (WAL + foreign keys)
       │
       ├── /audio/* → bundled original WAV narration (HTTP range requests)
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
    api.js                  Centralized REST client
    playback.js             Resume selection and time formatting
    *.test.*                Player lifecycle and resume tests
server/
  app.js                    Testable Express app, CORS, static audio, SPA serving
  index.js                  Environment loading and server lifecycle
  db.js                     Relational schema, prepared statements, seed transaction
  routes/api.js             Validated REST endpoints and recommendation rules
  content/catalog.js        Original story metadata and narration scripts
  public/audio/             Twelve WAV files and measured duration manifest
  scripts/                  Idempotent seed and optional audio generation
  test/api.test.js          HTTP integration and persistence tests
scripts/browser-smoke.mjs    Real Chrome/Chromium production smoke scenario
```

The API uses prepared SQL statements. Sort expressions come exclusively from a fixed allowlist. Search escapes SQL wildcard characters to treat user input literally. SQLite foreign keys, composite unique keys, and check constraints enforce relationships and valid progress. Listener writes use the fixed `demo-user` identity. There is no client-provided user selector.

### Database schema

| Table                | Key and important columns                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `stories`            | `id` PK; title, genre, author, tagline, description, color, symbol, popularity                                          |
| `chapters`           | `id` PK; `story_id` FK → stories; chapter_number, title, audio_url, duration_seconds; unique (story_id, chapter_number) |
| `favorites`          | Composite PK (user_id, story_id); story_id FK → stories; created_at                                                     |
| `listening_progress` | Composite PK (user_id, chapter_id); chapter_id FK → chapters; position_seconds, completed, updated_at                   |

Progress obtains its story identity through the chapter relationship rather than duplicating story IDs. Indexes support chapter lookup and listening recency. Times are UTC. Running `npm run seed` updates catalog content and preserves listener data. Runtime SQLite files are gitignored.

### Recommendation rules

1. Add **4 points per saved story** to that story's genre.
2. Add **2 points per distinct listened story** to its genre when it has positive progress or a completed chapter. Repeated playback updates and multiple chapters do not inflate this signal.
3. Exclude stories already in the library and fully completed stories.
4. Rank remaining stories by their genre score, then curated demo popularity, then ascending story ID. Return at most four, with a reason and score.

A new listener gets the curated popular catalog ordering. Popularity is seed metadata, not a fabricated real-world engagement metric. Equal input produces equal output. With six stories and five genres, matching candidates can be limited; popular fallback picks are expected.

## REST API

All endpoints use `/api`. GET responses use `{ stories }`, `{ story }`, `{ chapters }`, or the shapes specified below. Errors consistently use `{ "error": { "message": "..." } }`.

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
| PUT    | `/progress/:chapterId`             | Save `{ positionSeconds, completed? }`; returns `{ progress }`                                    |
| GET    | `/recommendations`                 | `{ strategy: "rule-based", stories }`; each story includes score and reason                       |

`sort` accepts `trending`, `title`, or `newest` (descending catalog ID). `q` is limited to 100 characters and `genre` to 40. Invalid IDs, repeated query values, invalid sorts, malformed JSON, unknown progress fields, and invalid positions return **400**. Unknown stories/chapters return **404**. JSON payloads are limited to 8 KB (**413**). Unexpected server failures return **500** without exposing internals.

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
npm test             # 18 HTTP integration + 11 client/player tests
npm run build        # Vite production compilation
npm run test:browser # build + real browser smoke, isolated temporary SQLite DB
```

**Verified results:** 18 API tests passed, 11 client/player tests passed, **0 failed**. The production build passed. All **12 browser smoke checks** passed in headless Google Chrome. The API tests verify all twelve WAV files contain nonzero PCM data and support HTTP byte ranges. The browser test actually decodes audio and observes playback time advancing.

Coverage includes favorites add/remove/idempotence; title and genre search; sorting; injection/wildcard inputs; invalid IDs and request bodies; progress upserts, completion, and SQLite close/reopen persistence; recommendation weighting/exclusions; player restore without autoplay; periodic/pause/seek/pagehide saves; automatic chapter transition; autoplay recovery; failed-save retry; and stale request handling.

The browser scenario checks playback across navigation, refresh restoration, favorite persistence, completion and automatic next chapter, search/sorting/empty/error states, responsive navigation, horizontal overflow, and uncaught JavaScript errors. It writes the screenshots in `docs/`. It uses installed macOS Chrome if available, `CHROME_PATH` if supplied, or Playwright Chromium elsewhere. On a host without Chrome:

```bash
npx playwright install chromium
npm run test:browser
```

Tests use disposable databases and do not change your demo library. Browser media policies have been tested in Chromium; Safari and mobile hardware have not been verified.

[Mobile screenshot](docs/soundwave-mobile.png)

## Audio and artwork

The twelve short chapters (approximately 32–37 seconds each) are original fiction in `server/content/catalog.js`, narrated locally using the macOS Samantha speech voice. They are bundled as mono 22.05 kHz PCM WAV files, approximately 18 MB total. `manifest.json` records actual measured durations. They require no third-party streaming URL. Cover artwork is original CSS/vector composition using Lucide icons (ISC), without external images or proprietary branding.

Optional regeneration on macOS with the Samantha voice installed:

```bash
npm run audio:generate
npm run seed
```

The generator reuses existing WAV files; remove the specific generated file before regenerating an edited script. Normal setup never runs this macOS-only command.

## Deployment and limitations

**No public deployment has been created or verified.** The app is verified locally in both development and production-serving modes. Hosting is the remaining optional deliverable.

For deployment, use a Node-capable host with persistent disk, run `npm ci && npm run build` during the build, and `npm start` as the start command. Set `DATABASE_PATH` to a writable path on the persistent volume and allow the host to provide `PORT`. Express serves both the frontend and API from the same origin, including deep links. Include `server/public/audio` in the deployment. Static-only hosting cannot run the SQLite/Express API.

SQLite data on an ephemeral filesystem disappears on restart/redeploy; mount persistent storage before expecting saved progress to survive deployments. Use one application instance for this demo's local database. A serverless Worker host would require changing the requested server/database stack, so it was not used.

Scope limits:

- One shared `demo-user`, intentionally no authentication or per-visitor privacy. All clients pointed at a server share its library/history.
- A small seeded catalog, synthesized short narration, and simple LIKE search; no uploads, subscriptions, offline playback, or production content pipeline.
- Rule-based recommendations over a tiny catalog; no claim of ML personalization or recommendation quality measurements.
- Pause/seek/transition saves are acknowledged by the API; unload/visibility saves are best effort. A crash or network failure can lose recent unsaved seconds. Errors are surfaced, with a retry action; there is no offline write queue. Concurrent tabs use last-arriving writes.
- No production authentication, abuse controls, monitoring, load benchmarks, or cross-browser certification. No real-user or performance-scale claims.

## Publish to GitHub

The project is prepared locally; it has not been pushed to GitHub. Create a repository with your preferred visibility, then connect and push it:

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

## Resume bullets

- Built a full-stack audio streaming application with React, Express, and SQLite, delivering discovery, a persistent audio player, and a server-backed favorites library.
- Designed validated REST APIs and relational schemas for chapter-level playback progress, enabling refresh-safe resume, Continue Listening, and automatic chapter transitions.
- Implemented backend search and deterministic genre-based recommendations, verified with 29 automated API/player tests and 12 real-browser smoke checks.
