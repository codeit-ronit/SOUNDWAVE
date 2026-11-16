# M1.1 — editable profile and per-account settings

Implemented on `feature/m1-private-playlists`. No push, public deployment, production data change or remote GitHub Actions run was performed. This is a listener settings slice; it adds no creator roles, queue editing or identity-management features.

Verified implementation commits: `f3eb147` (API/database) and `ea85b05` (Settings/player/browser/CI). This report and evidence are committed separately.

## Feature and REST contract

`/settings` uses the existing navigation/design. Profile identity loads independently of playback preferences. Display-name validation, read/write errors, retry, pending and successful-save states are visible. Email, verification status and whether Google is linked are read-only; no provider subject/token is exposed. Demo guests can save settings under their isolated owner, and registration/Google upgrades retain that owner ID.

All routes require the existing authenticated session (including isolated demo guests), use private/no-store responses and the existing API throttling/Redis-outage policy. PUT requires the existing session CSRF header and origin checks. The owner always comes from the session. Query parameters, extra body fields, client owner IDs and identity changes are rejected. Anonymous requests return 401; forged CSRF returns 403; validation returns 400; `/profile/:id` and `/settings/:id` are not routes. Account validation failures use `{error:{code,message}}`; authentication/CSRF failures retain the existing `{error:{message}}` envelope.

| Method/path         | Request                                                                     | Response (200)                                                     |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET `/api/profile`  | No query/body                                                               | `{profile:{id,displayName,email,kind,emailVerified,googleLinked}}` |
| PUT `/api/profile`  | Only `{displayName}`                                                        | `{profile: ...}`                                                   |
| GET `/api/settings` | No query/body                                                               | `{settings:{playbackSpeed,autoplayNext,defaultVolume,updatedAt}}`  |
| PUT `/api/settings` | Nonempty partial subset of `playbackSpeed`, `autoplayNext`, `defaultVolume` | Complete `{settings: ...}` after commit                            |

Display names are trimmed, 1–80 Unicode code points, with C0/C1 control characters rejected. Playback speed is a number from `0.75, 1, 1.25, 1.5, 2`; autoplay is a JSON boolean; volume is a finite number in `[0,1]`. Strings pretending to be numbers/booleans, nulls, arrays and unknown keys fail validation. New accounts/guests default to speed **1**, autoplay **true**, volume **0.8**, `updatedAt:null` until the first save. A read never inserts a preferences row.

Example using an existing session cookie and CSRF token:

```http
PUT /api/settings
Content-Type: application/json
X-CSRF-Token: <current-session-token>

{"playbackSpeed":1.5,"autoplayNext":false}
```

## Persistence and concurrency

Additive migrations: PostgreSQL `010_user_preferences.sql`, SQLite `011_user_preferences.sql`. `user_preferences.user_id` is a primary key and foreign key to `users` with cascading deletion. The primary-key index supports owner reads; CHECK constraints enforce allowed values. Existing user, identity, library, playlist, progress and analytics rows are retained. Run the normal `npm run db:migrate`; normal application startup also applies migrations. Do not edit previously applied migration files.

`server/routes/account.js` validates requests; `services/account.js` coordinates transactions; `repositories/account.js` binds SQL values. Profile and preferences writes lock the user row inside a transaction, including before a preferences row exists. Partial writes read/merge under that lock so simultaneous updates to different fields survive. SQLite uses the existing serialized transactional adapter. Same-field concurrent edits use last-committed-write semantics; there is no optimistic revision API.

SQLite import includes preferences and retains an already-existing target preference row rather than overwriting it. Backup manifests now cover **21 tables**, including a populated preferences fixture in real PostgreSQL restore verification. Keep historical backups/manifests with their corresponding schema/application version.

## Playback and account boundaries

`PreferencesContext.jsx` loads by owner/session, aborts superseded reads, snapshots the original session/patch and serializes saves. Session changes remount private state; late reads, late write responses and queued work cannot update the next account. `Settings.jsx` separately guards profile responses; `AuthContext.acceptProfile` checks owner, CSRF and account-switch state. Name changes update the header without rotating the session or remounting the player.

Saving settings changes rate/volume on the existing media element. Autoplay-off persists completion without automatically selecting the next chapter; manual next remains available. Existing player speed changes save to the current account. Player volume/mute is a temporary override; only Settings saves the default volume. Independent scalar effects avoid resetting volume/mute when only the name or autoplay changes.

A real browser test exposed an animation-frame race when an account switch detaches the media ref before passive cleanup. A minimal null guard stops that frame; a regression test invokes the queued frame after unmount and checks that it neither throws nor reschedules.

## Verification

**206 application tests passed (155 backend + 51 frontend), zero failed/skipped; six CI safety tests passed separately.** Eight Settings browser checks passed per database; the existing core 14, auth 5, offline 13, keyboard 3, restart/security 7 and playlist 10 checks passed. The clean-export CI runner additionally passed PostgreSQL playlists (10) and Settings (8), with login/offline/restart; production build (1,705 modules) and formatting passed. Dependencies were reused from the prior clean Node 22 install; `npm ci` was not repeated in this milestone.

Exact commands/results and changed files are in [m1-settings-verification.json](m1-settings-verification.json). Browser scenarios and timestamps are recorded separately for [SQLite](m1-settings-browser-sqlite.json) and [PostgreSQL](m1-settings-browser-postgres.json). The original 178 application tests remain; new coverage exercises profile/settings validation, owner/CSRF isolation, independent logins, guest/Google upgrades, concurrent merge/rollback, additive migrations, backup/import preservation, stale account responses and player continuity.

The CI runner now requires a successful PostgreSQL account-concurrency TAP result and includes Settings in its bounded browser job. Local verification is not evidence of a successful remote Actions run. M6.1 remains pending remote execution.

## Limits and follow-up

- Cross-session preferences restore on mount/login/refresh; **Reload saved preferences** explicitly fetches another device's latest changes. No real-time preference push or revision/conflict UI.
- Account settings require an online session. Private profile/preferences are never persisted to localStorage or service-worker caches. Offline anonymous playback uses defaults; existing public chapter downloads/range seeking remain supported. Autoplay is held off until preferences load successfully, preventing an unconfirmed saved preference from being ignored.
- A failed player-speed save leaves its immediate runtime rate and shows a recovery warning; it does not claim persistence. Offline speed changes are temporary. Device-global historical speed is not imported into account settings, avoiding cross-user leakage.
- Profile supports name editing only. Email reassignment, Google unlink/relink, password change, avatar upload, account deletion and session-management UI remain outside this milestone.
- Browser checks cover local headless Chrome; no cross-browser, public deployment, production-security or scalability claim is made. Actual Google provider UI was not exercised here; signed local verifier/upgrade tests cover identity preservation.
