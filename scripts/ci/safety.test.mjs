import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTestEnvironment, sanitizeLog } from "./safety.mjs";
const safe = {
  CI: "true",
  TEST_DATABASE_URL:
    "postgres://test:ephemeral@127.0.0.1:5432/soundwave_ci_tests",
  TEST_REDIS_URL: "redis://127.0.0.1:6379",
  REDIS_PREFIX: "ci-tests",
  TEST_BACKUP_CONTAINER: "postgres-service",
};
const options = { envFile: false, version: "22.21.1", backupRequired: true };
test("CI accepts only explicit disposable local services", () =>
  assert.equal(
    validateTestEnvironment(safe, options).database,
    "soundwave_ci_tests",
  ));
test("CI refuses missing services and backup test opt-outs", () => {
  for (const key of [
    "TEST_DATABASE_URL",
    "TEST_REDIS_URL",
    "REDIS_PREFIX",
    "TEST_BACKUP_CONTAINER",
  ])
    assert.throws(() =>
      validateTestEnvironment({ ...safe, [key]: "" }, options),
    );
});
test("CI refuses developer/production databases and URL query overrides", () => {
  for (const u of [
    "postgres://u:p@neon.example/soundwave_ci_tests",
    "postgres://u:p@127.0.0.1/soundwave",
    "postgres://u:p@127.0.0.1/soundwave_ci_tests?host=production.example",
  ])
    assert.throws(() =>
      validateTestEnvironment({ ...safe, TEST_DATABASE_URL: u }, options),
    );
});
test("CI refuses remote Redis and external email capture", () => {
  assert.throws(() =>
    validateTestEnvironment(
      { ...safe, TEST_REDIS_URL: "redis://remote.example:6379" },
      options,
    ),
  );
  assert.throws(() =>
    validateTestEnvironment(
      { ...safe, TEST_SMTP_URL: "smtps://mail.example:465" },
      options,
    ),
  );
});
test("CI refuses ambient application credentials, dotenv and unsupported Node", () => {
  for (const key of [
    "DATABASE_URL",
    "REDIS_URL",
    "SMTP_URL",
    "PGHOST",
    "PGSERVICE",
  ])
    assert.throws(() =>
      validateTestEnvironment({ ...safe, [key]: "configured" }, options),
    );
  assert.throws(() =>
    validateTestEnvironment(safe, { ...options, envFile: true }),
  );
  assert.throws(() =>
    validateTestEnvironment(safe, { ...options, version: "25.0.0" }),
  );
});
test("artifact sanitizer removes connection credentials, tokens and auth fields", () => {
  const raw =
    'postgres://u:secret@127.0.0.1/db\npassword: "hidden password"\nAuthorization: Bearer private\n' +
    "a".repeat(64) +
    "\neyJabc.credential.signature";
  const out = sanitizeLog(raw);
  for (const value of [
    "secret",
    "hidden password",
    "Bearer private",
    "a".repeat(64),
    "eyJabc",
  ])
    assert.ok(!out.includes(value));
  assert.equal(
    sanitizeLog("PASS 7: restored position 7.9"),
    "PASS 7: restored position 7.9",
  );
});
