# M1.3 — editable cross-story playback queue

Implemented locally on `feature/m1-private-playlists`. No server queue endpoint, database migration, new infrastructure, push, deployment or production data change. The existing PostgreSQL/SQLite APIs remain the catalog, progress, preferences and analytics source of truth.

Verified implementation commits: `39bc6fb`, `1c7369c`, `f7fdbbc`. Documentation/evidence is committed separately.

## Queue semantics

- The pure reducer in `client/src/queue.js` separates **current**, **upcoming** (maximum 50) and **history** (maximum 20). Each occurrence has a UUID plus catalog story/chapter references. Identical chapters are allowed with different occurrence IDs. Remove/reorder targets one occurrence, never all copies of a chapter.
- **Play Next** inserts the selected chapter at the front. **Add to Queue** appends. Story-card actions enqueue all that story's chapters in catalog order, including cards in a private playlist. An insertion that exceeds capacity is rejected as a whole, with an error. Enqueueing does not start playback, edit a playlist, favorite a story or write listening events.
- **Direct Play/Resume story** replaces upcoming with the selected story's remaining chapter order (up to 50). The selected chapter uses existing resume rules; preceding story chapters populate bounded Previous history. An explicitly queued occurrence starts at zero, so repeated chapters have deterministic replay behavior.
- **Next** consumes exactly one upcoming occurrence synchronously, using the existing audio element. **Previous** restores the last history occurrence at zero and returns current to the front. At 50 upcoming entries, remove one to enable Previous without dropping another entry. Queue controls never modify the current audio when reordering/removing/clearing upcoming.
- Completion saves progress once per active occurrence event. Autoplay-on consumes the latest upcoming order after save; autoplay-off leaves current completed/paused and retains upcoming. Manual Next works independently. An empty queue stops at the current chapter; it does not silently regenerate a story tail. With no current item, **Start queue** consumes its first upcoming item.
- Clear upcoming requires inline confirmation and keeps current/history. Controls use native buttons, labels and ordered lists, without drag/drop or animations. `/queue` is reachable from the persistent player's Queue link on desktop/mobile. Per-chapter actions are on story pages; whole-story actions appear on shared StoryCards (discovery/library/playlists).

## Transition correctness

`PlayerContext.jsx` keeps the reducer state in a synchronous ref and React view state. Rapid Next actions reserve distinct occurrences before any network operation. A late completion checks both active occurrence identity and request generation, so manual selection wins. Duplicate ended events share a completion latch. Previous/next/retry use the existing media element, rate, volume, seek/progress serialization and wall-clock analytics.

Catalog requests for enqueue operations run in invocation order and capture the original session. Account unmount, direct story selection and clear invalidate pending enqueue work. Restore requests are aborted on unmount and bounded to 15 seconds; a failed restore does not prevent direct playback replacing it. Profile/preferences updates keep the player mounted.

## Device-local persistence and privacy

`queueStorage.js` uses **sessionStorage**, deliberately scoped to a browser tab. A refresh retains the queue; closing the tab ends this persistence scope. There is no localStorage queue, backend synchronization, Redis private key or service-worker queue cache.

The version-1 envelope is capped at **20,000 characters** (serialized ASCII identifiers, under 20 KB): owner UUID, occurrence/story/chapter IDs, current numeric position, bounded upcoming/history. It stores no title, arbitrary audio URL, cookie, CSRF token, email, playlist identity or per-chapter history/progress data. Storage errors leave the in-memory queue usable and show a warning; corruption/invalid versions/oversized/forged shapes are discarded safely. Position is saved with progress snapshots, pause/seek/page-hide and queue transitions; it is not a per-animation-frame storage write.

On refresh, catalog reads validate references, bind chapters to their story and obtain current titles/audio URLs. Reads are deduplicated by story, bounded by 71 references and serialized; confirmed missing references are pruned. Other online read failures leave the original stored envelope intact with a refresh/replace warning. A direct play/edit can intentionally replace it. Restoring never autoplays. If no saved queue exists, the existing server Continue Listening restoration builds its chapter order paused.

Successful logout or a change to a different owner clears tab storage and advances a local storage generation, rejecting retired player writes during page-hide; existing cross-tab auth messages clear each receiving tab and reload. Owner comparison prevents restoring another account's envelope. A same-owner guest upgrade retains it. Cold offline refresh uses the last tab-local owner envelope as a local playback scope, not as an authenticated identity: APIs still have no offline session and private account reads remain unavailable. Offline validation retains only chapters with downloaded public metadata and cached audio. Offline enqueue rejects undownloaded audio. Public chapter download/removal/range handling is unchanged.

## Verification and findings

**240 application tests passed (155 backend + 85 frontend), zero failed/skipped; six CI safety tests passed separately.** Queue browser checks: 14 per database. Existing browser suites passed: core 14, auth 5, offline 13, keyboard 3, restart/security 7, playlists 10 and settings 8. The local CI runner also passed tests, build, formatting and its bounded browser gate (including PostgreSQL playlists/settings/queue). Production build transformed 1,708 modules.

Exact final commands, counts, changed files and limitations: [m1-queue-verification.json](m1-queue-verification.json). Browser evidence: [SQLite](m1-queue-browser-sqlite.json), [PostgreSQL](m1-queue-browser-postgres.json). CI now includes the queue smoke in its bounded mandatory browser gate; remote GitHub Actions remains **NOT RUN / NOT VERIFIED**.

New coverage includes the pure reducer, duplicate/reorder/remove/capacity edges, invalid/unavailable storage, offline validation, cross-story completion, duplicate completion events, pending clear/selection races, rapid Next, preserved rate/volume/time, timeout recovery and Settings test initialization synchronization. Existing backend and browser regressions remain required.

Final review also added a regression for cross-tab logout while the listening tab is offline: a storage-generation guard prevents the old player from recreating the cleared queue during page-hide.

Two test setup issues were corrected: a new disposable PostgreSQL database needed the documented migration/seed before backup tests; corrupt-storage fault injection must execute after page-hide persistence, immediately before app bootstrap. Tests wait for real save acknowledgements/media state rather than sleeps.

## Limits and follow-up

- Queue is per-tab, not shared across tabs/devices or synchronized through PostgreSQL. Tab closure/storage eviction can lose it; server listening progress remains independently persisted. This milestone does not solve M1.5 device conflicts.
- Future queued occurrences replay from zero; only the current saved occurrence restores its tab-local position. Analytics/completion counts retain existing per-chapter backend semantics rather than counting each queued replay as a new unique completion.
- Offline restoration prunes unavailable/download-removed items; an online catalog outage preserves the original snapshot until retry or explicit replacement. Restored catalog references are not a guarantee that external provider audio is reachable later. Playback errors use the existing Retry/Next controls.
- Browser verification is local headless Chrome, not a cross-browser claim. An intermittent Chrome media network error (code 2) was observed when replaying an already-loaded source after downloads became available during the combined fault-injection scenario. Its cause has not been established. The offline regression phase starts from a refreshed, catalog-validated queue and checks actual playback; hot cache publication into an existing media load remains a reliability concern to investigate separately. No speculative service-worker change was made.
- No editable backend queue, creator feature, queue sharing, drag/drop, shuffle, notifications or new authentication flow was added.
