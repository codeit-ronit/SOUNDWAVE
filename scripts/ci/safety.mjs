import { existsSync } from "node:fs";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function validateTestEnvironment(
  env,
  {
    backupRequired = false,
    envFile = existsSync(".env"),
    version = process.versions.node,
  } = {},
) {
  if (!/^22\./.test(version)) throw Error("CI requires Node.js 22.");
  if (env.CI !== "true") throw Error("Set CI=true for the isolated CI runner.");
  if (envFile)
    throw Error(
      "CI refuses a checkout containing .env; use a clean disposable export.",
    );
  if (
    env.DATABASE_URL ||
    env.REDIS_URL ||
    env.SMTP_URL ||
    env.PGHOST ||
    env.PGSERVICE
  )
    throw Error("CI refuses application/service connection overrides.");
  let pg, redis;
  try {
    pg = new URL(env.TEST_DATABASE_URL);
    redis = new URL(env.TEST_REDIS_URL);
  } catch {
    throw Error("CI requires explicit local test database and Redis URLs.");
  }
  if (
    !["postgres:", "postgresql:"].includes(pg.protocol) ||
    !loopback.has(pg.hostname) ||
    pg.search ||
    pg.hash ||
    !/^\/soundwave_ci_[a-z0-9_]+$/.test(pg.pathname) ||
    pg.pathname.length > 64
  )
    throw Error(
      "CI requires a disposable loopback soundwave_ci_* database without URL overrides.",
    );
  if (
    redis.protocol !== "redis:" ||
    !loopback.has(redis.hostname) ||
    redis.search ||
    redis.hash ||
    !/^\/(?:[0-9]|1[0-5])?$/.test(redis.pathname || "/")
  )
    throw Error(
      "CI requires a dedicated loopback Redis without URL overrides.",
    );
  if (!/^ci-[a-zA-Z0-9-]{1,70}$/.test(env.REDIS_PREFIX || ""))
    throw Error("CI requires an explicit ci-* Redis namespace.");
  if (
    backupRequired &&
    !/^[a-zA-Z0-9_-]{1,100}$/.test(env.TEST_BACKUP_CONTAINER || "")
  )
    throw Error(
      "CI requires the matching disposable PostgreSQL backup container.",
    );
  for (const [name, protocols] of [
    ["TEST_SMTP_URL", ["smtp:", "smtps:"]],
    ["TEST_MAILPIT_URL", ["http:"]],
  ]) {
    if (!env[name]) continue;
    let u;
    try {
      u = new URL(env[name]);
    } catch {
      throw Error("Invalid local mail test URL.");
    }
    if (
      !loopback.has(u.hostname) ||
      !protocols.includes(u.protocol) ||
      u.search ||
      u.hash
    )
      throw Error("CI mail capture must be loopback-only.");
  }
  return {
    database: pg.pathname.slice(1),
    postgresHost: pg.hostname,
    redisHost: redis.hostname,
  };
}

export function sanitizeLog(value) {
  return String(value)
    .replace(
      /\b(?:postgres(?:ql)?|redis|rediss|smtp|smtps):\/\/[^\s"'<>]+/gi,
      "[redacted-service-url]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-jwt]",
    )
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-token]")
    .replace(
      /((?:password|credential|token|csrfToken|cookie|authorization)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
      "$1[redacted]",
    )
    .replace(
      /^.*\b(?:cookie|authorization)\s*:\s*.*$/gim,
      "[redacted-auth-header]",
    );
}
