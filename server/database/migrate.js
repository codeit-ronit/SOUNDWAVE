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
