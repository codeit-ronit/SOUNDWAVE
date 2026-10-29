import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  createReadStream,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
const tables = [
  "users",
  "sessions",
  "stories",
  "chapters",
  "favorites",
  "listening_progress",
  "progress_write_versions",
  "listening_events",
  "account_tokens",
  "background_jobs",
  "analytics_rollups",
  "schema_migrations",
  "catalog_revision",
];
const pool = (url) =>
  new pg.Pool({
    connectionString: url,
    max: 1,
    options: "-c timezone=UTC",
    connectionTimeoutMillis: 5000,
  });
async function fingerprint(client) {
  const result = {};
  for (const table of tables)
    result[table] = (
      await client.query(
        `SELECT COUNT(*)::text AS count,COALESCE(SUM(hashtextextended(to_jsonb(t)::text,0)::numeric),0)::text AS fingerprint FROM public.${table} t`,
      )
    ).rows[0];
  return result;
}
async function sha(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function tooling(kind, url, args, { container, input, output } = {}) {
  const parsed = new URL(url),
    database = decodeURIComponent(parsed.pathname.slice(1)),
    username = decodeURIComponent(parsed.username);
  const binary = kind === "dump" ? "pg_dump" : "pg_restore";
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: username,
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database,
    PGOPTIONS: "-c timezone=UTC",
  };
  if (parsed.searchParams.get("sslmode"))
    env.PGSSLMODE = parsed.searchParams.get("sslmode");
  if (process.env.PGSSL === "true") env.PGSSLMODE = "verify-full";
  const command = container
    ? "docker"
    : (kind === "dump"
        ? process.env.PG_DUMP_BIN
        : process.env.PG_RESTORE_BIN) || binary;
  const argv = container
    ? [
        "exec",
        "-i",
        container,
        binary,
        "--username",
        username,
        "--dbname",
        database,
        ...args,
      ]
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      env,
      stdio: [input ?? "ignore", output ?? "ignore", "pipe"],
    });
    // Tool stderr may include sensitive COPY values. Report bounded error codes only.
    child.stderr.resume();
    child.once("error", () =>
      reject(
        Error(
          `${binary} could not start; install matching PostgreSQL tools or configure BACKUP_PG_CONTAINER`,
        ),
      ),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `${binary} failed with exit ${code}; archive/restore not verified`,
            ),
          ),
    );
  });
}
export async function backupDatabase(url, path, { container } = {}) {
  const db = pool(url),
    client = await db.connect();
  let fd,
    created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await client.query("SELECT pg_export_snapshot() AS id"))
      .rows[0].id;
    const counts = await fingerprint(client);
    await tooling(
      "dump",
      url,
      [
        "--format=custom",
        "--schema=public",
        "--no-owner",
        "--no-privileges",
        `--snapshot=${snapshot}`,
      ],
      { container, output: fd },
    );
    closeSync(fd);
    fd = undefined;
    const metadata = {
      version: 1,
      scope: "public",
      createdAt: new Date().toISOString(),
      sha256: await sha(path),
      tables: counts,
    };
    writeFileSync(path + ".json", JSON.stringify(metadata, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await client.query("COMMIT");
    return metadata;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(path);
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}
export async function verifyBackup(url, path, { container } = {}) {
  const manifest = JSON.parse(readFileSync(path + ".json", "utf8"));
  if (manifest.version !== 1 || manifest.sha256 !== (await sha(path)))
    throw Error("Archive integrity check failed");
  const name = "soundwave_restore_" + randomBytes(12).toString("hex");
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = pool(adminUrl.toString());
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const target = new URL(url);
    target.pathname = "/" + name;
    if (manifest.scope === "public") {
      // pg_dump --schema=public includes CREATE SCHEMA. Remove only the empty
      // schema in this brand-new, randomly named drill database.
      const fresh = pool(target.toString());
      try {
        await fresh.query("DROP SCHEMA public");
      } finally {
        await fresh.end();
      }
    }
    const fd = openSync(path, "r");
    try {
      await tooling(
        "restore",
        target.toString(),
        ["--no-owner", "--no-privileges", "--exit-on-error"],
        { container, input: fd },
      );
    } finally {
      closeSync(fd);
    }
    const restored = pool(target.toString());
    try {
      const actual = await fingerprint(restored);
      if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
        throw Error(
          "Restored table fingerprints differ from the snapshot manifest",
        );
      return { verified: true, tables: tables.length };
    } finally {
      await restored.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
