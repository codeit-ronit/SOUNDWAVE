# SoundWave: proposed ₹0 hosting

**Prepared 14 November 2026; no cloud resources created or deployment performed.** This is a plan with local evidence, not a guarantee of available free capacity or a zero bill.

## Smallest safe topology

Use one Oracle Always Free ARM VM running the standalone `compose.release.yaml`: Caddy serves HTTPS and proxies to Express, which already serves the bundled React SPA, API and authorized media. PostgreSQL, Redis and the FFmpeg worker remain private. All browser requests, session cookies, service-worker downloads and audio ranges retain one origin. No frontend rewrite is needed.

Vercel Hobby is optional. It is intended for personal, noncommercial use; check eligibility and current allowances. Its documented included transfer is 100 GB Fast Data Transfer and 10 GB Fast Origin Transfer. This is not unlimited audio hosting. See [Hobby](https://vercel.com/docs/plans/hobby) and [fair use](https://vercel.com/docs/limits/fair-use-guidelines).

The current client uses same-origin `/api` requests and credentials. Direct cross-site API hosting would require cookie/CORS/client/offline changes and browser-policy verification. Instead, a future Vercel variant could retain same-origin [external rewrites](https://vercel.com/docs/routing/rewrites); `deploy/vercel.frontend.example.json` is an **inactive placeholder**. Upload sizes, ranges, HEAD, cookies, service worker, forwarded client IP and provider quotas must be tested before choosing it. Root `vercel.json` still references the historical backend and is intentionally unchanged. Do not enable automatic deployment of this branch using that configuration.

## Free allocation and cost stops

Oracle's [current Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) states 1,500 A1 OCPU-hours and 9,000 GB-hours monthly, equivalent to **2 OCPU / 12 GB total**, plus 200 GB combined boot/block storage and five volume backups. Home-region capacity is not guaranteed. Idle A1 instances can be reclaimed after seven days when the documented CPU, network and memory thresholds are all low. Do not manufacture traffic to avoid reclamation. Free trial credits are not an Always Free allocation.

Propose **one 2-OCPU / 6-GB ARM VM with a 100-GB boot disk**: at 31 days, 1,488 OCPU-hours and 4,464 GB-hours, assuming no other account consumption. This is our budget, not a verified account entitlement.

| Item                                                            | Status / decision before M6-B                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A1 VM and 100-GB boot volume                                    | Within the documented allowance if eligible, available and otherwise unused; verify console labels and estimate  |
| PostgreSQL, Redis, API, worker, Caddy                           | Open-source containers on that VM; no managed-service subscriptions                                              |
| Named volumes on boot disk                                      | Persistent across container restart; not independent of disk/VM loss                                             |
| Public IPv4, outbound transfer, region-specific network charges | Account/region pricing and allowances **NOT VERIFIED**; stop if any nonzero estimate                             |
| Hostname/domain/DNS                                             | No domain purchased or DNS created; use an owner-controlled eligible hostname or separately verified free option |
| Certificate                                                     | Caddy automatic ACME configuration prepared; public DNS, issuance and renewal **NOT VERIFIED**                   |
| Offsite/encrypted backup destination                            | **NOT CONFIGURED**; cost, access and retention require owner selection                                           |
| Email / external providers                                      | Disabled by default; no paid sender/API introduced                                                               |
| Vercel                                                          | Optional, eligibility/usage conditional; no project changes authorized                                           |

**No-unintended-spend rule:** do not upgrade to paid, substitute a paid shape, attach a card/billing commitment, buy a domain, enable paid managed services or consume trial credits as a workaround. Require an explicit Always Free label and zero estimate for every resource. If capacity or pricing is unclear, stop. Budget alerts are not spending caps. Recheck current pricing/terms in the actual account before approval.

## Resource envelope

| Service                | CPU cap |   RAM cap |
| ---------------------- | ------: | --------: |
| PostgreSQL             |    0.50 |   768 MiB |
| Redis                  |    0.10 |   128 MiB |
| API                    |    0.50 |   384 MiB |
| Worker / FFmpeg        |    0.75 |   512 MiB |
| Caddy                  |    0.15 |    96 MiB |
| Total running services |    2.00 | 1,888 MiB |

The separate migration container uses 0.5 CPU / 384 MiB while writers are drained. Leave remaining VM RAM for Docker, Linux, filesystem cache and builds; production builds can still exhaust a small VM. Build sequentially or transfer verified ARM images if necessary. These limits passed a small local workflow, not a capacity/load guarantee.

Volumes: `postgres_data`, `redis_data` (AOF/noeviction, 64-MB Redis data cap), `private_media`, `caddy_data`, `caddy_config`. Keep at least 15 GB free and monitor database, originals, derivatives, Docker layers and backups. Existing per-creator upload limits are not a global disk quota. Rotate/delete approved old artifacts and move encrypted backups off host; do not run `down -v` on real data. Single-VM failure, exhaustion and reclamation remain operational risks.

## Security and origin configuration

- Copy `deploy/*.example` to protected files outside Git, e.g. `/etc/soundwave` directory mode 0700, files 0600. Use independent random administrator, migrator, runtime and Redis credentials. Hex passwords avoid URL/config quoting surprises. Never print resolved Compose configuration or upload env files/logged secrets.
- `release.env` contains file paths, hostname/contact and quarantine control. PostgreSQL receives only `postgres.env`; API/worker receive only `runtime.env`; operator containers receive only `migrator.env`. Redis reads a password-protected config mounted read-only. Docker/root access can read these secrets; they are not a vault.
- On the target Linux host, make `redis.conf` readable by the image's Redis service UID/GID while retaining mode 0600; inspect with `docker run --rm --network none --entrypoint id redis:7.4-alpine redis` before setting ownership. Other env files remain operator-owned. A root-owned 0600 bind mount may be unreadable after Redis drops privileges. Confirm health before proceeding; macOS bind-mount permission behavior does not certify the VM's host ownership.
- Use the exact HTTPS hostname in `APP_ORIGIN`. No broad CORS origins are needed. Production uses Secure, HttpOnly, SameSite=Lax host-only session cookies and the existing CSRF checks. Configure the public Google Web Client ID and authorize that exact JavaScript origin in Google Cloud. The existing Google credential-token flow uses no client secret or OAuth redirect endpoint. Real Google sign-in at the new host is pending owner verification.
- Only Caddy publishes 80/443. Allow administrative SSH only from the owner's IP/CIDR. Review cloud security lists and host/Docker rules; do not assume a host firewall automatically filters published Docker ports. No database, Redis, API or worker ports may be public.
- Caddy overwrites forwarded headers; Express trusts only its fixed `172.29.240.2/32` address. API uses `.3`. Reserve this subnet or update both together after checking collisions. Do not trust every proxy/IP. See [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- `RELEASE_QUARANTINED=true` is the release default: traffic/readiness fail closed and workers refuse work. Keep proxy ingress closed until checks and authorization succeed. Quarantine is not a substitute for stopping old writers during migrations/restores.
- Private files have no static route; approved media streams through SQL authorization and integrity checks. Previously downloaded/buffered audio cannot be remotely recalled.

Local proof: [seven release-stack checks](m6-release-stack.json) ran through Caddy HTTPS on loopback with a narrowly pinned disposable certificate, native Linux ARM64 images, production cookies, upload/FFmpeg/publication, offline ranges, spoofed forwarding headers and quarantine. This does **not** verify public ACME, Oracle capacity, public routing, Google at a new hostname or sustained uptime. Follow the [release runbook](M6_RELEASE_CANDIDATE.md) only after M6-B approval.
