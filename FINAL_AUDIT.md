# SoundWave — Final Independent Engineering Audit

**Date:** 29 October 2026. **Baseline inspected:** committed HEAD `3e65415`, with a clean working tree at audit start. **Verified fixes:** `5e76da4` and `3827c3e`. Environment: Node 22.21.1, npm 10.9.4, macOS, installed Google Chrome. This report records executed checks, not earlier conversation claims.

**Result:** the demo works, and the audit found and repaired real defects. **Durable public SQLite persistence on Vercel remains FAIL.** Durable persistence on the normal Node server passes real process-restart tests. Native OS installation and cross-browser coverage remain NOT VERIFIED.

## Assessment by requested area

| Area                                          | Status                                               | Evidence / limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Actual committed implementation            | **PASS**                                             | Read the player, API client, library, offline provider, service worker, schema, routes, middleware, build and test scripts. Audio uses HTML5 media and actual WAV files; favorites/progress/events use SQLite; recommendations are deterministic SQL/rules. No mocked production service substitutes were found. Seed popularity is curated metadata, not real engagement.                                                                                                                         |
| 2. Tests and clean production build           | **PASS**                                             | Clean `npm ci`; all **40 backend + 21 frontend tests passed, zero failures**. Removed `client/dist` and rebuilt successfully. Formatting check passed. `npm audit` reported zero advisories; that is not a complete supply-chain assessment.                                                                                                                                                                                                                                                       |
| 3. Restart persistence                        | **PASS locally; FAIL for durable Vercel hosting**    | An independent Chrome script terminates and starts fresh Node processes against a temporary disk database. Position, paused-player restoration, favorites, exact analytics totals, idempotency records, completion and next-chapter selection survive. Legacy-schema initialization preserves existing rows. Vercel's `/tmp` adapter has no durable/shared database guarantee.                                                                                                                     |
| 4. HTTP streaming and file resolution         | **PASS**                                             | Full GET matches file bytes; bounded, open, suffix and clamped ranges return exact 206 slices; malformed/multiple/unsatisfiable ranges return 416. HEAD supplies headers without a body; Range on HEAD is ignored. If-Range is tested. API and legacy audio routes now share validated mappings and real-path containment, including symlink/non-file tests. Production code streams from disk.                                                                                                    |
| 5. PWA and selected offline chapters          | **PASS in Chrome; native installation NOT VERIFIED** | Active service worker, hashed shell cache, stale-cache cleanup, manifest/icons, explicit complete-file downloads, offline shell reload, actual offline audio decoding, 206/416 offline ranges, seeking and removal passed. Partial 206 and truncated 200 downloads are rejected. Simulated quota exhaustion produces an error and no available-download entry. An isolated regular Chrome profile reports no installability errors. Installing/uninstalling through native OS UI was not executed. |
| 6. SQL, validation, abuse controls and errors | **PASS within demo scope**                           | Prepared SQL, fixed sort allowlist, literal wildcard escaping, validated IDs/types/durations/version metadata, malformed JSON/URI handling, 8 KB body limit, JSON errors, request IDs and bounded recent-activity results are exercised. JSON API limiting returns 429/Retry-After. Stream requests are deliberately exempt.                                                                                                                                                                       |
| 7. Security review                            | **PASS for checked controls; concerns remain below** | Tracked-text secret-pattern scan found no matches. `.env`, runtime SQLite and `.vercel/` are ignored. No production `dangerouslySetInnerHTML`, `document.write`, `eval` or dynamic code construction was found. A database HTML payload renders as text in Chrome. Arbitrary origins are not reflected and credentialed CORS is not enabled. A legacy audio symlink exposure was reproduced and fixed.                                                                                             |
| 8. Rate limits versus normal listening        | **PASS for tested use**                              | Existing playback/analytics scenarios pass with the default limiter. A rapid 80-change slider drag now makes one coalesced write in the unit test and at most two in the browser audit, preserving its final position. At JSON quota, audio range streaming still works. Forwarding-header spoofing cannot evade the direct-server bucket. Concurrent public traffic/load is NOT VERIFIED.                                                                                                         |
| 9. Analytics accuracy                         | **PASS for received demo events**                    | Actual media intervals, pause/seek/buffering exclusions, repeated native events/rerenders, UUID retries/conflicts, favorite transitions and completion retries are covered. Reverse-order progress writes cannot undo newer state or create a stale completion event. Restart tests preserve exact totals. Seeking to the end can mark a chapter complete but does not add skipped seconds. Metrics are client-observed, not tamper-proof engagement telemetry.                                    |
| 10. README commands                           | **PASS for core commands**                           | Executed `npm ci`, `npm test`, `npm run build`, `npm run dev`, `npm start`, `npm run seed`, formatting, core/offline/audit scripts. Development page/API proxy and range response returned 200/200/206; production page/API returned 200. Optional macOS narration regeneration was not rerun; bundled files were independently verified.                                                                                                                                                          |
| 11. Public deployment                         | **PASS for demo access; persistence gap remains**    | Public HTTPS page, SPA deep links, health, HEAD, 206/416 and actual Chrome playback passed. Source includes a Vercel adapter, audio inclusion and SPA/API rewrites. Login protection was removed for this project after explicit owner approval. A Linux remote build repaired the initial Mac-native SQLite failure. Durable database hosting, distributed limits and production operations are not implemented/verified.                                                                         |

## Defects found and repaired

1. **Rapid seeking flooded the API.** At baseline, a simulated slider drag generated **80 progress writes**, each potentially causing additional history/recommendation reads. Writes now coalesce for 400 ms; pause, chapter changes and page-hide flush immediately. Timers are cleared on cleanup. Seeking itself remains immediate.
2. **Legacy `/audio` bypassed file-safety checks.** The new chapter stream rejected an out-of-root symlink, but the old static route returned its contents with HTTP 200. Both routes now use the same catalog lookup, filename validation, real-path boundary and streaming handler. Non-file targets return a JSON 404. The regression changes the database mapping and creates disposable fixtures; it does not modify real recordings.
3. **Unload writes could overtake older queued writes.** The client serialized regular saves but dispatched keepalive saves separately. A late older request could rewind a newer position/completion. Snapshots now carry a tab client UUID and monotonic sequence captured before dispatch. An additive `progress_write_versions` table rejects old/duplicate versions in the same transaction as progress/completion handling. Original unversioned callers remain compatible. This is per-client ordering, not conflict resolution between independent listeners.
4. **Deployment was not portable as a Mac prebuilt function.** The first temporary deployment packaged a Mach-O SQLite addon and failed in the Linux runtime. Node 22.x is now pinned, the serverless adapter uses writable temporary storage, audio files are explicitly included, and deployment uses Vercel's remote Linux build. This repairs execution, not durability.

5. **Keyboard focus disabled advertised shortcuts.** The handler ignored all buttons, including the focused Start listening launcher. Playback buttons now opt into Space toggling; arrows work after button clicks; editable fields and native activation of unrelated buttons remain protected. A focused-button regression and three real Chrome keyboard checks pass.

The original 52 tests all passed despite the first two defects. New regression tests initially failed (`404` expected but `200` returned; 80 unexpected writes); they now pass. The audit added ordering, validation, CORS, forwarded-header, schema-preservation and offline-failure checks rather than merely rerunning the earlier suite.

## Actual verification results

| Executed check                             | Result                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                   | PASS; lockfile install succeeded                                                                                                                   |
| `npm test`                                 | **61 passed, 0 failed**: 40 Node HTTP integration tests, 21 Vitest frontend/player tests                                                           |
| Removed build output, then `npm run build` | PASS; Vite compiled and generated the precached service worker                                                                                     |
| `node scripts/browser-smoke.mjs`           | **14 passed**: real audio, 206 delivery, navigation, refresh, favorites, transitions, analytics, search, mobile layout                             |
| `node scripts/offline-smoke.mjs`           | **13 passed**: regular Chrome profile, offline playback/ranges, timer/speed/shortcuts, removal, partial/truncated downloads and quota failures     |
| `node scripts/audit-smoke.mjs`             | **7 passed**: actual process restarts, bounded seek writes, exact analytics persistence/idempotency, stale completion protection and HTML escaping |
| `node scripts/keyboard-smoke.mjs`          | **3 passed**: actual focused launch/player buttons, Space toggles, ±10-second arrows, unaffected search typing                                     |
| `npm run format:check`                     | PASS                                                                                                                                               |
| `npm audit --json`                         | 0 reported vulnerabilities                                                                                                                         |
| Source/ignore review                       | No secret-pattern matches in tracked text; runtime credentials/data are excluded                                                                   |
| Public HTTP + Chrome checks                | Homepage/deep-link/API/HEAD 200; range 206; invalid range 416; actual media time advances                                                          |
| Exact submitted resume URL                 | 307 redirect to the working app; verified through Chrome navigation and actual playback                                                            |

The sleep-timer test advances a controlled browser clock by five minutes; it does not pretend a five-minute real-time wait was performed. Fault injection is confined to tests. Product playback and offline decoding use actual audio.

Restart tests use isolated databases and fresh processes. A first completion-fixture attempt allowed the old tab to write while another client changed its state; the harness now closes that writer before checking controlled completion durability. Independent clients still share last-arriving-write behavior, as documented. A missing filesystem import in an audit fixture was also corrected before the final passing run.

Live follow-up: `node scripts/public-smoke.mjs` passed all **5 public checks**, including offline reload/play/ranges and download removal. `node scripts/keyboard-smoke.mjs https://soundwave-codeit-ronit.vercel.app` passed all **3 keyboard checks**. Deployment `dpl_3Jb6cymNKhb8EydkjyHwKAiHgfcB` is READY and serves the keyboard fix at the stable URL. The initial sandboxed integration run could not bind localhost (`EPERM`); the permitted rerun passed all 61 tests.

## Remaining concerns and unverified functionality

- **FAIL — durable Vercel data:** `api/index.js` stores SQLite under `/tmp`. Cold starts, instance changes and redeploys can reset or separate favorites, progress, events and ordering records. A successful warm-instance request is not proof of persistent hosting.
- **Shared public demo:** all visitors use `demo-user`. Anyone can mutate the demo's data. No authentication, authorization, private per-user data, trusted engagement measurement or offline mutation queue is implemented. Do not store sensitive data here.
- **Abuse/resource limits:** the 300/minute limiter is per process/IP, not distributed. Behind proxies, buckets can be shared. Do not trust arbitrary forwarding headers. Audio is exempt from app rate limits; bandwidth limits, monitoring and adversarial load/resource-leak testing remain outstanding.
- **Browser storage:** selected audio is explicit and limited to 25 MB per file; the current immutable catalog has only twelve files (about 18 MB). There is no automatic audio-catalog caching. The JSON metadata cache can accumulate search-query variants until browser quota/eviction; it has no explicit LRU cap. Browsers may evict downloads. These limits matter before expanding the catalog.
- **Analytics limits:** only received events count; failed/offline intervals are not queued. Delayed intervals are capped and can undercount. Completion means current saved playhead completion, not proof every second was heard. Genuine replay can create another completion event; repeated writes of the same completed state do not. Different clients/unversioned API calls can still overwrite shared state.
- **NOT VERIFIED:** native OS installation, Safari/Firefox, physical mobile hardware, prolonged background timer behavior, large audio files, concurrent users, latency/throughput targets, backups/restoration and durable public storage. No production-readiness or scalability claim is supported.
- **Submitted link dependency:** keep the original claimed temporary deployment and project redirect. Its expiry fields were absent after claim, but its provider-managed hostname cannot be reassigned as a normal owned domain. The stable branded URL is preferred for future resumes. Do not delete the old deployment while the submitted link is needed.

## Exact publishing and maintenance steps

### Existing Vercel portfolio demo — temporary data

1. Use Node 22.x, clone `https://github.com/codeit-ronit/SOUNDWAVE`, and run:

   ```bash
   npm ci
   npm test
   npm run build
   npm run test:browser
   npm run test:offline
   npm run test:audit
   ```

2. Authenticate as the owner and link the existing project, then deploy from source so Linux dependencies are built remotely:

   ```bash
   npx vercel login
   npx vercel link --yes --project zippy-nitrogen-wd3scr3 --scope ronit-choudharys-projects
   npx vercel deploy --prod --yes --scope ronit-choudharys-projects
   ```

   Keep the repository root as the project root. `vercel.json` supplies `npm ci`, `npm run build`, `client/dist`, API/audio rewrites and `server/public/audio/**` function inclusion. Do not deploy a Mac-built `.vercel/output` function as Linux code. CLI deployment works; automatic GitHub deployment is not configured/verified.

3. Keep `soundwave-codeit-ronit.vercel.app` attached to the project. Public access requires this project's login protection to stay disabled; the owner explicitly approved this. No other project's protection was changed.

4. Retain the published project-level resume redirect. It is a separate live Vercel setting, not a rule in the old deployment's source:

   ```json
   {
     "src": "^/(.*)$",
     "dest": "https://soundwave-codeit-ronit.vercel.app/$1",
     "status": 307,
     "has": [{ "type": "host", "value": "zippy-nitrogen-wd3scr3.tmp.now" }]
   }
   ```

   Review with `vercel routes export`. Project-level routing applies without rebuilding the old deployment; see [Vercel routing documentation](https://vercel.com/docs/cli/routes). Match the hostname exactly to avoid redirecting the destination to itself.

5. After deployment, verify without authentication:

   ```bash
   curl -f https://soundwave-codeit-ronit.vercel.app/api/health
   curl -I https://soundwave-codeit-ronit.vercel.app/stories/1
   curl -I https://soundwave-codeit-ronit.vercel.app/api/chapters/101/stream
   curl -D - -o /dev/null -H 'Range: bytes=0-99' \
     https://soundwave-codeit-ronit.vercel.app/api/chapters/101/stream
   curl -IL https://zippy-nitrogen-wd3scr3.tmp.now/
   ```

   Also open the submitted URL in a fresh browser, play audio, seek, refresh, and exercise a selected offline download. The source contains no persistent database or Vercel credentials.

### A public demo with durable saved data — not yet deployed

Use a Node host with a persistent writable volume and one app instance, run the same install/test/build commands, then set `DATABASE_PATH` to the volume's absolute SQLite path and start with `npm start`. Include all bundled audio assets. Terminate TLS with a valid HTTPS certificate; forward `/api`, audio and SPA routes to Express. If frontend/API origins differ, set `CLIENT_ORIGIN` to the exact frontend origin and configure the proxy accordingly. Configure proxy trust only for the actual trusted proxy.

Before claiming durable public persistence, save progress/favorites/events, stop and start the host, redeploy, and verify the same data survives on the mounted volume. Test backups and provider disk retention. This durable host/backend has not been created; Vercel alone with the current `/tmp` adapter does not satisfy this requirement.

## Three truthful resume bullets

- Engineered Express audio delivery with disk-based HTTP byte ranges, HEAD support and validated file mappings, verified with media-delivery and path-safety integration tests.
- Built resumable React audio playback backed by SQLite, repairing rapid-seek request flooding and out-of-order saves and verifying state across real server restarts.
- Delivered selective offline audio and event-based listening analytics, validated with 61 automated tests and 37 local browser/process smoke checks.
