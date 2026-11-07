import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateTestEnvironment, sanitizeLog } from "./safety.mjs";

const mode = process.argv[2];
if (
  ![
    "install",
    "browsers",
    "test",
    "build",
    "format",
    "browser",
    "extended",
  ].includes(mode)
)
  throw Error("Choose a documented CI runner mode.");
const environment = validateTestEnvironment(process.env, {
  backupRequired: mode === "test",
});
const dir = resolve("artifacts/ci");
mkdirSync(join(dir, "logs"), { recursive: true });
const env = {
  ...process.env,
  DATABASE_URL: "",
  DATABASE_DRIVER: "sqlite",
  DATABASE_PATH: "",
  REDIS_URL: "",
  SMTP_URL: "",
  EMAIL_MODE: "disabled",
  GOOGLE_CLIENT_ID: "",
  LIBRIVOX_CATALOG: "false",
  MEDIA_JOBS: "false",
  HTTP_LOG: "0",
  PGSSL: "",
  NPM_CONFIG_USERCONFIG: "/dev/null",
  BROWSER_ARTIFACT_DIR: join(dir, "browser"),
};
const results = [];
async function run(name, command, args, timeout = 180000) {
  const file = join(dir, "logs", name + ".log");
  writeFileSync(file, "");
  const started = Date.now();
  const child = spawn(command, args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  const kill = (signal) => {
    try {
      process.platform !== "win32"
        ? process.kill(-child.pid, signal)
        : child.kill(signal);
    } catch {}
  };
  let hardStop;
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    hardStop = setTimeout(() => kill("SIGKILL"), 5000);
  }, timeout);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    const output = (line) => {
      const safe = sanitizeLog(line);
      appendFileSync(file, safe);
      process.stdout.write(safe);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        output(pending.slice(0, at + 1));
        pending = pending.slice(at + 1);
      }
      if (pending.length > 65536) {
        output("[oversized log line omitted]\n");
        pending = "";
      }
    });
    stream.on("end", () => {
      if (pending) output(pending + "\n");
    });
  }
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
  clearTimeout(timer);
  clearTimeout(hardStop);
  results.push({
    name,
    exitCode: code,
    timedOut,
    durationMs: Date.now() - started,
  });
  writeFileSync(
    join(dir, mode + ".json"),
    JSON.stringify({ mode, environment, results }, null, 2) + "\n",
  );
  if (code !== 0 || timedOut)
    throw Error(`CI command ${name} failed; see sanitized artifact log.`);
  return file;
}
const node = (name, file, args = [], timeout) =>
  run(name, process.execPath, [file, ...args], timeout);
try {
  if (mode === "install")
    await run("install", "npm", ["ci", "--no-fund"], 300000);
  if (mode === "browsers")
    await run(
      "browser-install",
      "npx",
      ["--no-install", "playwright", "install", "--with-deps", "chromium"],
      300000,
    );
  if (mode === "test") {
    await run("ci-safety", process.execPath, [
      "--test",
      "scripts/ci/safety.test.mjs",
    ]);
    // Explicit fresh migration/seed, then the full unchanged backend/frontend scripts.
    const saved = env.DATABASE_URL;
    env.DATABASE_URL = env.TEST_DATABASE_URL;
    await run("migrations", "npm", ["run", "db:migrate"]);
    env.DATABASE_URL = saved;
    const log = await run("tests", "npm", ["test"], 360000);
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(log, "utf8");
    const required = [
      "postgres: transaction rollback, concurrent completions and stale progress writes",
      "PostgreSQL fresh concurrent migrations",
      "postgres: playlist reads/writes reject anonymous sessions",
      "postgres: concurrent playlist additions serialize",
      "Redis atomically shares request limits across independent application instances",
      "real PostgreSQL backup restores all 20",
    ];
    const missing = required.filter(
      (evidence) =>
        !text
          .split("\n")
          .some((line) => /^ok \d+ - /.test(line) && line.includes(evidence)),
    );
    const zeroSkipped = /^# skipped 0$/m.test(text);
    writeFileSync(
      join(dir, "integration-coverage.json"),
      JSON.stringify({ required, missing, zeroSkipped }, null, 2) + "\n",
    );
    if (missing.length || !zeroSkipped)
      throw Error(
        "Required PostgreSQL/Redis/backup coverage is missing or skipped; inspect integration-coverage.json.",
      );
  }
  if (mode === "build") await run("build", "npm", ["run", "build"]);
  if (mode === "format") {
    await run("format", "npm", ["run", "format:check"]);
    await run("ci-doc-format", "npx", [
      "--no-install",
      "prettier",
      "--check",
      "docs/CI.md",
      "docs/CI_FLAKE_INVESTIGATION.md",
    ]);
  }
  if (mode === "browser")
    for (const [name, file] of [
      ["login", "auth-smoke"],
      ["playlists", "playlists-smoke"],
      ["offline", "offline-smoke"],
      ["restart", "audit-smoke"],
    ])
      await node(name, `scripts/${file}.mjs`);
  if (mode === "extended") {
    if (!env.TEST_SMTP_URL || !env.TEST_MAILPIT_URL)
      throw Error("Extended checks require explicit local SMTP capture URLs.");
    for (const [name, file] of [
      ["systems", "systems-smoke"],
      ["worker-restart", "media-restart-smoke"],
      ["demo-supervisor", "demo-smoke"],
    ])
      await node(name, `scripts/${file}.mjs`, [], 240000);
    await node("http-load", "scripts/http-load.mjs", [
      join(dir, "http-load.json"),
    ]);
  }
} catch (error) {
  console.error(sanitizeLog(error.message));
  process.exitCode = 1;
}
