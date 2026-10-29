// Writes a temporary account on an explicitly supplied LOCAL test deployment.
// Run with `seed` before container restart and `verify` afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [base, phase, file] = process.argv.slice(2);
if (
  !base ||
  !["seed", "verify"].includes(phase) ||
  !file ||
  !["127.0.0.1", "localhost"].includes(new URL(base).hostname)
)
  throw Error(
    "Usage: node scripts/container-smoke.mjs http://127.0.0.1:PORT seed|verify /tmp/state.json",
  );
let state =
  phase === "verify"
    ? JSON.parse(readFileSync(file, "utf8"))
    : { cookie: "", csrfToken: "" };
async function call(path, method = "GET", body) {
  const response = await fetch(base + "/api" + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      Cookie: state.cookie,
      "X-CSRF-Token": state.csrfToken,
      Origin: base,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) state.cookie = cookie.split(";")[0];
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  if (result.csrfToken) state.csrfToken = result.csrfToken;
  return result;
}
assert.equal((await call("/health")).database, "postgres");
if (phase === "seed") {
  await call("/auth/session");
  const registration = await call("/auth/register", "POST", {
    email: `container-${randomUUID()}@example.com`,
    password: "container verification password!",
    displayName: "Container fixture",
  });
  state.userId = registration.user.id;
  await call("/library/1", "PUT");
  await call("/progress/101", "PUT", { positionSeconds: 8.25 });
  state.overview = await call("/analytics/overview");
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  console.log(
    "PASS: Compose app registers an account and persists favorites, progress and analytics in PostgreSQL",
  );
} else {
  assert.equal((await call("/auth/session")).user.id, state.userId);
  assert.equal((await call("/library")).stories[0].id, 1);
  assert.equal((await call("/progress")).progress[0].position_seconds, 8.25);
  assert.deepEqual(await call("/analytics/overview"), state.overview);
  console.log(
    "PASS: authenticated session, library, progress and exact analytics survive app AND PostgreSQL container restart",
  );
}
