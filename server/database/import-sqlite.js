import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
// An explicit administrative operation. Source is read-only, held at one SQLite
// snapshot; target is one PostgreSQL transaction. No sessions are copied.
export async function importSqlite(db, path) {
  if (db.dialect !== "postgres")
    throw Error("Import target must be PostgreSQL");
  const source = new Database(path, { readonly: true, fileMustExist: true });
  const counts = {};
  try {
    source.exec("BEGIN");
    const has = (name) =>
      !!source
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    const tables = [
      "stories",
      "chapters",
      "favorites",
      "listening_progress",
      "progress_write_versions",
      "listening_events",
    ];
    const rows = Object.fromEntries(
      tables.map((t) => [
        t,
        has(t) ? source.prepare(`SELECT * FROM ${t}`).all() : [],
      ]),
    );
    const users = has("users")
      ? source.prepare("SELECT * FROM users").all()
      : [];
    const known = new Set(users.map((u) => u.id));
    for (const t of tables.slice(2))
      for (const row of rows[t])
        if (!known.has(row.user_id)) {
          users.push({
            id: row.user_id,
            email: null,
            password_hash: null,
            display_name: "Imported legacy listener",
            kind: "legacy",
            created_at: new Date().toISOString(),
          });
          known.add(row.user_id);
        }
    await db.transaction(async () => {
      await db
        .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
        .run(randomUUID());
      for (const [table, data] of [
        ["users", users],
        ...tables.map((t) => [t, rows[t]]),
      ]) {
        counts[table] = 0;
        for (const row of data) {
          // Column names originate only in the known SQLite schema, not requests.
          const columns = Object.keys(row).filter((k) => k !== "event_order");
          if (columns.some((k) => !/^\w+$/.test(k)))
            throw Error("Invalid source column");
          const result = await db
            .prepare(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
            )
            .run(...columns.map((k) => row[k]));
          counts[table] += result.changes;
        }
      }
    });
    source.exec("COMMIT");
    return counts;
  } finally {
    source.close();
  }
}
