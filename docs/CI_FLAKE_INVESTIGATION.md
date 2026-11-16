# Restart/browser flake investigation

7 November 2026. Scope: the intermittent exact-position restore failure recorded at M1.2. No production data or application behavior was changed.

## Reproduction and evidence

Five sequential isolated runs of the original restart script produced **four passes and one failure**, at the existing assertion waiting for paused audio near 7.9 seconds after a server restart. Five additional instrumented isolated runs likewise produced **four passes and one failure**. Each run used a new temporary SQLite database, Node server and browser; no retries were used within a test. [Evidence](ci-flake-evidence.json).

The failing instrumented run showed:

- An initial pause persisted **1.158796 seconds**, sequence 1.
- The browser seek reached **7.9 seconds**, but there was **no seek-save PUT** before the test advanced into server shutdown/reload.
- The restore API returned **1.158796**, and the healthy paused media element restored **1.158796** (readyState 4, no media error).

This is evidence of a **test synchronization error**, not a failure of the server to retain an acknowledged 7.9-second write. The application intentionally debounces seeks; the old test had not actually waited for that write. This conclusion applies to the reproduced failure, not every possible cross-device/persistence race.

## Root cause

The script called `page.waitForFunction(async () => { fetch progress; return condition; })`. In the lockfile-installed Playwright **1.64.1**, its polling implementation tests the returned Promise for truthiness before awaiting its resolved value. A direct local probe with `waitForFunction(async () => false)` returned a handle whose value was **false**, instead of polling/timing out. The test merely awaited the handle and never asserted its boolean value. Its “wait” could therefore complete while the debounced save was still pending. The same pattern affected the initial analytics check and two checks in the existing core browser script.

The investigation inspected `node_modules/playwright-core/lib/coreBundle.js` (`waitForFunctionExpression`, `const success = predicate()`), the pinned version in `package-lock.json`, and the real request/media trace. No dependency upgrade or product rewrite was needed.

## Minimal correction

[browser-sync.mjs](../scripts/browser-sync.mjs) arms successful API-response acknowledgements **before** the UI action:

1. Wait for the relevant playback-paused event response, then explicitly assert analytics from a fresh read.
2. Before the 80 slider changes, wait for a successful progress-write response containing the expected 7.9-second position.
3. Explicitly assert a fresh progress read is within the original 0.05-second tolerance, then restart.
4. Keep the existing post-restart 0.1-second tolerance, paused-state check, maximum two seek writes, exact analytics totals and idempotency assertions unchanged.

The core browser script now uses the same acknowledgement barriers. Failure diagnostics preserve only numeric media state, save sequences/positions and response status; no cookies/tokens/credentials or raw browser state are recorded. CI additionally masks screenshots.

There are **no fixed sleeps, increased restoration timeouts, automatic retries, relaxed assertions or application code changes** in this fix. The 10-second response barrier is a deadline for the actual condition, not a delay before proceeding.

## Verification and limits

Five isolated corrected runs passed all seven checks each, **0/5 reproduced failures**. The clean CI-equivalent browser job also executes the corrected restart check; actual command results are recorded in [ci-verification.json](ci-verification.json). Absence of a failure in a finite sample does not certify universal reliability. CI now fails and captures evidence on the first failure.

The historical M1 timeout/rerun evidence remains in its original report; this report explains the reproduced cause rather than rewriting the earlier result as an uninterrupted pass. A real GitHub Actions Linux/Chromium run has **not** executed; its behavior remains a separate verification gate.
