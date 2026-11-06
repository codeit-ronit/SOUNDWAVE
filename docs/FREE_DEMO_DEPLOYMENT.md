# Free public demo deployment

This is a deployment recipe, **not a claim of a completed public rollout**. The existing Vercel URLs must keep serving their working deployment until the new backend passes public checks.

## Selected services

- Render **Free web service**: current frontend/API and a supervised worker process in the same container.
- Render **Free Key Value**: Redis-compatible cache, shared rate limits and BullMQ queue, private network only, `noeviction` policy.
- Neon **Free PostgreSQL**: authoritative accounts, sessions, favorites, history, analytics/outbox and derived media results. Render's free PostgreSQL expires after 30 days, so this recipe does not use it.
- Existing Vercel project: retains the resume hostname and serves the current frontend, proxying `/api/*` and `/audio/*` to the verified Render backend.

Provider constraints checked on 6 November 2026: [Render Free](https://render.com/docs/free), [Key Value](https://render.com/docs/key-value), [Neon pricing](https://neon.com/pricing). Stay on free plans, do not enable paid upgrades, and check quotas in the provider dashboards. Providers can change plans or require account verification.

This setup has deliberate limitations:

- Render sleeps after 15 minutes without inbound traffic. The next visit can take about a minute to wake it. API and worker both sleep; jobs are not continuously processed while asleep. No artificial keep-alive is configured.
- Free Redis is in-memory only. A Redis restart loses cache, limiter counters and BullMQ queue state. Catalog media work can be reconstructed from PostgreSQL and the bundled audio when the worker starts again. This does **not** preserve arbitrary failed-job history or guarantee durable Redis jobs.
- PostgreSQL-backed sessions, user records, analytics jobs and processed metadata survive those Redis losses. Neon has monthly storage/compute quotas. This does not verify high availability or disaster recovery.
- Both processes share the free service's resource budget. Separate API/worker services remain the normal Docker Compose architecture; this small-demo launcher does not demonstrate independent scaling.
- Email delivery is disabled. Registration, login and individual guest sessions work; verification/password-reset delivery explicitly reports unavailable until a supported SMTP provider is configured. Render Free blocks common SMTP ports.

## Account and database setup

1. Sign up with GitHub at [Render](https://dashboard.render.com) and [Neon](https://console.neon.tech). Choose their free plans. Account signup and provider authorization require the account owner.
2. Create a Neon project named `soundwave-demo`, preferably Frankfurt to match the Blueprint. Create/use database `neondb` and save its **direct/unpooled** PostgreSQL connection string. The direct connection preserves session-level options and locking semantics used by the existing adapter. Use the TLS URL Neon supplies.
3. Store the connection string only in Render's `DATABASE_URL` secret prompt. Do not put it in Git, an issue, a README or chat.

## Create the free Render services

Open [Deploy the SoundWave Blueprint](https://render.com/deploy?repo=https://github.com/codeit-ronit/SOUNDWAVE). Authorize access to the repository when Render asks. The root `render.yaml` explicitly chooses `plan: free` for both resources and prompts for `DATABASE_URL`. Inspect the plan summary before creating the services; it should contain no paid service.

The Blueprint builds the existing Dockerfile and overrides its command with `node server/scripts/demo.js`. The launcher starts the existing API and worker, forwards termination and stops the API if either child exits unexpectedly. The host can then restart the service instead of silently leaving jobs unprocessed. No new queue or database implementation is introduced.

`APP_ORIGIN` is deliberately `https://soundwave-codeit-ronit.vercel.app`: visitors will use the existing Vercel frontend, and cookies are HTTP-only and Secure in production. Before Vercel cutover, test public health, catalog and audio directly on the Render URL. Do not use the Render frontend for sign-in with this origin configuration.

Deployment runs additive migrations and seeds the catalog. The worker backfills missing metadata/waveforms. Bundled source WAV files are included in the image, so this demo does not require uploads or a persistent media disk. Existing data in an unrelated local or old ephemeral Vercel database is **not automatically copied** into Neon.

## Verify and cut over the existing resume link

After Render reports a successful deployment, record its actual HTTPS hostname (it may include a suffix). Verify:

1. `/api/health`: `database` is `postgres`.
2. `/api/ready`: PostgreSQL and Redis ready.
3. `/api/stories`, title search, genre filters and a deep-link route work.
4. `/api/chapters/101/metadata`: real waveform/metadata reaches 200.
5. Chapter GET, HEAD and range GET produce 200/206, invalid ranges 416.

Only then update Vercel's API/audio rewrites to that exact HTTPS Render hostname and build/deploy the **current Git commit** to a preview. Set the Vercel project's Node version to 22.x to match the repository. The current frontend uses same-origin APIs; do not expose database/Redis credentials through Vite environment variables.

On the preview, test browser playback, guest creation, favorites, refresh resume, offline download/range playback/removal and analytics. Production cookies and CSRF require the actual frontend origin: use a matching staging origin for a fully interactive preview or verify after a controlled production cutover with rollback available. Promote the verified deployment to `soundwave-codeit-ronit.vercel.app`; retain the original claimed deployment and hostname redirect for `zippy-nitrogen-wd3scr3.tmp.now`.

Finally, verify **both resume URLs** anonymously, check that the frontend includes the new account controls, and test independent guest data. Restart the Render service and verify favorites/progress remain in PostgreSQL and the worker resumes. Update README deployment status only after these public checks pass. A GitHub push, a successful image build or a healthy local container alone is not evidence of public deployment.

## Local verification of the free-service launcher

The new launcher can be checked against disposable local services:

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/test_database \
TEST_REDIS_URL=redis://localhost:6379 npm run test:demo
```

The test creates/removes a generated PostgreSQL database and requires a role allowed to do so. It runs real API/worker child processes, authenticates, saves a favorite, streams a range, kills the worker with SIGKILL, verifies the supervisor stops the API, restarts and checks persistence, and tests graceful termination and invalid startup configuration. It never targets a public database.
