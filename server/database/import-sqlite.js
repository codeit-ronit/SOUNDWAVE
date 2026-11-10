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
      "creator_profiles",
      "stories",
      "chapters",
      "story_sources",
      "chapter_sources",
      "favorites",
      "listening_progress",
      "progress_write_versions",
      "listening_events",
      "oauth_identities",
      "playlists",
      "playlist_items",
      "user_preferences",
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
    for (const t of [
      "favorites",
      "listening_progress",
      "progress_write_versions",
      "listening_events",
    ])
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
    const retainedProgress = new Set(),
      importedProgress = new Set();
    await db.transaction(async () => {
      // Match runtime owner -> chapter lock ordering for concurrent imports.
      for (const user of [...users].sort((a, b) => a.id.localeCompare(b.id)))
        await db
          .prepare("SELECT id FROM users WHERE id=? FOR UPDATE")
          .get(user.id);
      await db
        .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
        .run(randomUUID());
      for (const [table, data] of [
        ["users", users],
        ...tables.map((t) => [t, rows[t]]),
      ]) {
        counts[table] = 0;
        for (const row of data) {
          if (
            table === "listening_progress" ||
            table === "progress_write_versions"
          )
            await db.lockProgress(row.user_id, row.chapter_id);
          if (
            table === "progress_write_versions" &&
            row.request_hash &&
            !importedProgress.has(`${row.user_id}:${row.chapter_id}`)
          )
            continue;
          // A receipt cannot describe a retained target's different progress.
          if (
            table === "progress_write_versions" &&
            retainedProgress.has(`${row.user_id}:${row.chapter_id}`)
          )
            continue;
          // Never attach imported memberships to an existing different owner's list.
          if (table === "playlists") {
            const target = await db
              .prepare("SELECT user_id FROM playlists WHERE id=? FOR UPDATE")
              .get(row.id);
            if (target && target.user_id !== row.user_id)
              throw Error("Playlist ownership conflict during import");
          }
          if (table === "stories") {
            if (row.ownership_kind === undefined)
              row.ownership_kind = rows.story_sources.some(
                (x) => x.story_id === row.id,
              )
                ? "external"
                : "system";
            const target = await db
              .prepare(
                "SELECT owner_id,ownership_kind FROM stories WHERE id=? FOR UPDATE",
              )
              .get(row.id);
            if (
              target &&
              (target.ownership_kind !== row.ownership_kind ||
                target.owner_id !== (row.owner_id ?? null))
            )
              throw Error("Story ownership conflict during import");
          }
          if (table === "chapters") {
            const target = await db
              .prepare("SELECT story_id FROM chapters WHERE id=? FOR UPDATE")
              .get(row.id);
            if (target && target.story_id !== row.story_id)
              throw Error("Chapter ownership conflict during import");
          }
          // Column names originate only in the known SQLite schema, not requests.
          const columns = Object.keys(row).filter((k) => k !== "event_order");
          if (columns.some((k) => !/^\w+$/.test(k)))
            throw Error("Invalid source column");
          const result = await db
            .prepare(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
            )
            .run(...columns.map((k) => row[k]));
          if (table === "listening_progress" && !result.changes)
            retainedProgress.add(`${row.user_id}:${row.chapter_id}`);
          if (table === "listening_progress" && result.changes)
            importedProgress.add(`${row.user_id}:${row.chapter_id}`);
          if (table === "listening_progress" && result.changes)
            await db
              .prepare(
                "UPDATE users SET history_revision=history_revision+1 WHERE id=?",
              )
              .run(row.user_id);
          counts[table] += result.changes;
        }
      }
      // Existing target keys are retained, but newly imported positions must not
      // collide with the target's next append. Locks above exclude concurrent adds.
      for (const row of rows.playlists) {
        const items = await db
          .prepare(
            "SELECT COUNT(*) AS count,COALESCE(MAX(position),0) AS last FROM playlist_items WHERE playlist_id=?",
          )
          .get(row.id);
        if (items.count > 100 || items.last >= Number.MAX_SAFE_INTEGER)
          throw Error("Playlist import exceeds membership/order limits");
        await db
          .prepare(
            "UPDATE playlists SET next_position=GREATEST(next_position,?) WHERE id=? AND user_id=?",
          )
          .run(items.last + 1, row.id, row.user_id);
      }
    });
    source.exec("COMMIT");
    return counts;
  } finally {
    source.close();
  }
}
