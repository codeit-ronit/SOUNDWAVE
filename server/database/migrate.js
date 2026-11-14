import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export async function migrate(db) {
  await db.transaction(async () => {
    if (db.dialect === "postgres")
      await db.prepare("SELECT pg_advisory_xact_lock(731298421)").get();
    await db
      .prepare(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      )
      .run();
    const dir = new URL(`../migrations/${db.dialect}/`, import.meta.url);
    const known = new Set(
      readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)),
    );
    for (const row of await db
      .prepare("SELECT version FROM schema_migrations")
      .all())
      if (!known.has(row.version))
        throw Error(
          "Database has a newer/unknown schema; drain this writer and use matching code.",
        );
    for (const version of readdirSync(dir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort()) {
      const sql = readFileSync(new URL(version, dir), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
        .get(version);
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${version}`);
        continue;
      }
      // Migrations are trusted, version-controlled SQL, never request values.
      if (db.dialect === "postgres") {
        for (const statement of sql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await db.prepare(statement).run();
      } else db.raw.exec(sql);
      await db
        .prepare(
          "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
        )
        .run(version, checksum, new Date().toISOString());
    }
  });
}

// Runtime startup: read-only compatibility check; no DDL, seeding or revision writes.
export async function verifySchema(db) {
  const dir = new URL(`../migrations/${db.dialect}/`, import.meta.url);
  const known = new Map(
    readdirSync(dir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(new URL(f, dir), "utf8"))
          .digest("hex"),
      ]),
  );
  const rows = await db
    .prepare("SELECT version,checksum FROM schema_migrations")
    .all();
  if (
    rows.length !== known.size ||
    rows.some((r) => known.get(r.version) !== r.checksum)
  )
    throw Error(
      "Schema does not match this release; use the matching migrator before runtime startup.",
    );
  return { verified: true, migrations: rows.length };
}
