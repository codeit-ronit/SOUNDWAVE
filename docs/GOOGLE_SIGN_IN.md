# Google sign-in implementation and verification

Checkpoint: 6–7 November 2026. Public app: https://soundwave-codeit-ronit.vercel.app/.

## Implemented

- Official Google Identity Services button on sign-in and sign-up; explicit linking for signed-in password users. Password and independent guest access remain available.
- Optional server-side `GOOGLE_CLIENT_ID`, returned as public configuration. No client secret or Google password is required by the application. Without configuration the option is disabled.
- JOSE validates Google's RS256 ID-token signature against its fixed HTTPS JWKS endpoint, audience, issuer, expiry, issued-at time, verified email, authorized party when present, and a session-bound nonce. Key-fetch errors return a controlled failure.
- Five-minute challenges store only a nonce hash. CSRF/session checks, single-use transactional consumption, identity uniqueness, row/advisory locks and rotated HTTP-only sessions protect the exchange. No ID token is retained or logged.
- Guest registration preserves the guest's library/history. Returning Google subjects resolve their existing account. Existing email addresses are never automatically linked: sign in with the password, then choose **Link Google**. Logging into an existing account does not merge guest histories.
- Google-only users use an intentionally invalid password marker to satisfy the existing SQLite registered-user constraint without rebuilding it. Password login and email password-reset cannot create password access for these accounts; recovery is through Google. Previously linked password accounts retain their existing password recovery.
- Only authoritative Gmail/verified Workspace addresses establish application email verification. Other Google email addresses do not silently verify the application's email ownership.
- Additive PostgreSQL migration 008 / SQLite migration 009 create identity and challenge tables with foreign keys, uniqueness and an expiry index. Backup manifests cover 18 tables. Imports preserve identities but never import sessions/challenges; worker maintenance expires challenges.
- Public privacy page at `/privacy.html`, Google SDK failure/retry states and popup-compatible response headers, including the frontend root.

## Configuration

1. In Google Auth Platform choose **External** for this public portfolio app, then create a **Web application** OAuth client.
2. Add `https://soundwave-codeit-ronit.vercel.app` as an authorized JavaScript origin. For local development, add the exact origins used, such as `http://localhost:5173` and `http://localhost:3001`. Origins have no path. The legacy resume URL redirects to the canonical origin before the widget loads.
3. Set `GOOGLE_CLIENT_ID` in the API environment and restart/redeploy the API. Compose passes this optional variable through. The browser obtains it from `/api/auth/session`, so no separate Vite secret/build variable is needed.
4. Configure the public app name, support details and privacy URL in Google. Follow Google's current audience/publication prompts. Basic Sign in with Google using only identity/profile/email has an exception to the usual Testing test-user restriction; this implementation does not request Gmail, Drive or other API scopes. See [Google audience documentation](https://support.google.com/cloud/answer/15549945?hl=en).
5. Complete a real sign-in in a normal browser and verify logout/returning login. Never share passwords, ID tokens or client secrets in issues or chat.

The implementation follows Google's [server verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) and [JavaScript reference](https://developers.google.com/identity/gsi/web/reference/js-reference). Google consent-screen/branding verification is a separate owner-controlled process and is not claimed here.

## Actual verification

| Check                                                          | Result                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full automated suite with PostgreSQL, Redis and backup tooling | **153 passed**, 0 failed/skipped: 122 backend + 31 frontend                                                                                                    |
| Production frontend build                                      | **PASS**, 1,702 transformed modules                                                                                                                            |
| Existing password/guest browser suite                          | **5 passed**, SQLite-backed Chrome                                                                                                                             |
| Existing offline/range/storage browser suite                   | **13 passed**                                                                                                                                                  |
| Existing hosted application smoke suite after Google rollout   | **9 passed**: streaming, favorites/resume, password registration/login/logout, isolation, PWA downloads/offline seeking, CSRF and analytics                    |
| New hosted Google UI/provider-page smoke                       | **5 passed**: privacy page, real sign-in button, real sign-up button, mobile layout/no page exceptions, actual Google sign-in page without client/origin error |
| Hosted frontend root, sign-in query and privacy headers        | **PASS**: HTTP 200 and `Cross-Origin-Opener-Policy: same-origin-allow-popups`                                                                                  |
| Completed real Google account login                            | **NOT VERIFIED** by automation; owner browser completion requested                                                                                             |

Backend Google tests use genuinely RSA-signed local JWT fixtures and test JWKS through the actual JOSE verifier; they do not impersonate Google in the public deployment. Cases cover both adapters, invalid signature/audience/issuer/expiry/email/nonce, replay and cross-session challenges, concurrency, logout/revoked-session races, key-fetch outages, explicit linking, data isolation and Google-only recovery. Four frontend cases stub the Google SDK to test callbacks, StrictMode, challenge errors and SDK retries. Those tests do not prove a real Google account completed sign-in.

Reproduction (use disposable local infrastructure):

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 \
TEST_BACKUP_CONTAINER=YOUR_MATCHING_LOCAL_POSTGRES_CONTAINER npm test
npm run build
node scripts/auth-smoke.mjs
node scripts/offline-smoke.mjs
node scripts/public-google-smoke.mjs docs/google-public-ui-results.json
```

The exact local run used PostgreSQL on port 55433, Redis on 56379 and `soundwave-phase1-pg18` backup tools. Public Google results are committed in [google-public-ui-results.json](google-public-ui-results.json). The script visits the actual provider sign-in page but never enters Google credentials. The separate public core script creates a test account; its latest fixture remains pending explicitly approved cleanup after automatic review rejected deletion of hosted records.

## Released versions and remaining limits

Backend runtime commit `e80b0c5`: Render deployment `dep-dbn1od3ncjis73cai190`. Frontend root-header fix `ca525d5`: Vercel deployment `dpl_72DhvitdoTjFN1XxFAPUzhvyScLb`, promoted to the canonical public URL. Documentation-only follow-ups do not change runtime behavior.

Free hosting still sleeps and Redis state remains volatile; external mail delivery remains disabled. Google/network/blocked-SDK outages display errors while password/guest options remain available. Google-only recovery depends on the provider. Chrome checks do not establish cross-browser compatibility. MFA, self-service unlinking/deletion and a third-party security assessment are not implemented. No production security, Google app verification or scalability certification is claimed.
