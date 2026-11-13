import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { storyMetadata, chapterMetadata } from "../services/draft-contract.js";
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
      "draft_create_receipts",
      "private_media_assets",
      "private_media_heads",
      "private_processing_intents",
      "private_media_outputs",
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
    const sourceAllocations = has("creator_id_allocations")
      ? source.prepare("SELECT * FROM creator_id_allocations").all()
      : [];
    const sourcePrivate = new Set(
      rows.stories
        .filter((s) => s.ownership_kind === "creator")
        .map((s) => s.id),
    );
    for (const story of rows.stories.filter((s) => sourcePrivate.has(s.id))) {
      storyMetadata({ ...story, language: story.language ?? "und" });
      const chapters = rows.chapters.filter((c) => c.story_id === story.id);
      if (
        chapters.length > 500 ||
        chapters.filter((c) => !c.draft_removed).length > 100
      )
        throw Error("Draft import exceeds chapter limits");
      for (const chapter of chapters)
        chapterMetadata({ ...chapter, summary: chapter.summary ?? "" });
    }
    const retainedDrafts = new Set(),
      importedStories = new Set(),
      importedChapters = new Set();
    const retainedProgress = new Set(),
      importedProgress = new Set();
    await db.transaction(async () => {
      // Match runtime owner -> chapter lock ordering for concurrent imports.
      for (const id of [
        ...new Set([
          ...users.map((u) => u.id),
          ...rows.stories.map((s) => s.owner_id).filter(Boolean),
        ]),
      ].sort())
        await db.prepare("SELECT id FROM users WHERE id=? FOR UPDATE").get(id);
      // Match API lock order before any new resource insertion. APIs allocate
      // only one kind per request; imports lock both in a fixed order.
      await db
        .prepare(
          "SELECT kind FROM creator_id_allocations ORDER BY kind" +
            (db.dialect === "postgres" ? " FOR UPDATE" : ""),
        )
        .all();
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
              .prepare("SELECT owner_id,ownership_kind FROM stories WHERE id=?")
              .get(row.id);
            if (
              target &&
              (target.ownership_kind !== row.ownership_kind ||
                target.owner_id !== (row.owner_id ?? null))
            )
              throw Error("Story ownership conflict during import");
            if (target?.ownership_kind === "creator")
              retainedDrafts.add(row.id);
          }
          if (table === "chapters") {
            const target = await db
              .prepare("SELECT story_id FROM chapters WHERE id=?")
              .get(row.id);
            if (target && target.story_id !== row.story_id)
              throw Error("Chapter ownership conflict during import");
            if (retainedDrafts.has(row.story_id)) continue;
          }
          if (table === "draft_create_receipts") {
            const target = await db
              .prepare(
                "SELECT * FROM draft_create_receipts WHERE user_id=? AND request_id=?",
              )
              .get(row.user_id, row.request_id);
            if (
              target &&
              (target.request_hash !== row.request_hash ||
                target.kind !== row.kind ||
                target.story_id !== row.story_id ||
                target.chapter_id !== row.chapter_id)
            )
              throw Error("Draft receipt identity conflict during import");
            if (
              target ||
              !(row.kind === "story"
                ? importedStories.has(row.story_id)
                : importedChapters.has(row.chapter_id))
            )
              continue;
          }
          if (
            table === "private_media_assets" ||
            table === "private_media_heads"
          ) {
            const target = await db
              .prepare(
                `SELECT * FROM ${table} WHERE ${table === "private_media_assets" ? "id" : "chapter_id"}=?`,
              )
              .get(table === "private_media_assets" ? row.id : row.chapter_id);
            if (
              target &&
              (target.user_id !== row.user_id ||
                target.chapter_id !== row.chapter_id ||
                target.story_id !== row.story_id)
            )
              throw Error("Private media ownership conflict during import");
            if (
              retainedDrafts.has(row.story_id) ||
              target ||
              !importedChapters.has(row.chapter_id)
            )
              continue;
            if (
              !Number.isSafeInteger(row.revision) ||
              row.revision >= Number.MAX_SAFE_INTEGER
            )
              throw Error("Invalid imported media revision");
            // Database import does not transport private files. Never claim an
            // imported pointer is playable or delete objects belonging to this root.
            row.revision++;
            if (table === "private_media_assets") {
              row.status = row.status === "deleted" ? "deleted" : "failed";
              row.object_key = randomBytes(32).toString("hex");
              row.storage_released = 1;
              row.cleanup_error = 0;
              row.lease_token = null;
              row.lease_until = null;
              row.error_code = "RESTORE_BYTES_REQUIRED";
            } else row.asset_id = null;
          }
          if (table === "private_processing_intents") {
            if (
              retainedDrafts.has(row.story_id) ||
              !importedChapters.has(row.chapter_id)
            )
              continue;
            const existing = await db
              .prepare(
                "SELECT * FROM private_processing_intents WHERE id=? OR asset_id=?",
              )
              .get(row.id, row.asset_id);
            if (existing) {
              if (
                existing.user_id !== row.user_id ||
                existing.asset_id !== row.asset_id
              )
                throw Error("Processing ownership conflict during import");
              continue;
            }
            row.status = "failed";
            row.stage = "failed";
            row.error_code = "RESTORE_BYTES_REQUIRED";
            row.revision++;
            row.outbox_id = null;
            row.lease_token = null;
            row.lease_until = null;
          }
          if (table === "private_media_outputs") {
            const parent = rows.private_processing_intents.find(
              (p) => p.id === row.intent_id,
            );
            if (
              !parent ||
              retainedDrafts.has(parent.story_id) ||
              !importedChapters.has(parent.chapter_id)
            )
              continue;
            row.status = "deleted";
            row.storage_released = 1;
            row.lease_until = null;
            row.cleanup_error = 0;
            row.object_key = randomBytes(32).toString("hex");
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
          if (table === "stories" && result.changes)
            importedStories.add(row.id);
          if (table === "chapters" && result.changes)
            importedChapters.add(row.id);
          counts[table] += result.changes;
        }
      }
      counts.creator_id_allocations = 0;
      for (const kind of ["chapter", "story"]) {
        const src = sourceAllocations.find((row) => row.kind === kind),
          table = kind === "story" ? "stories" : "chapters";
        if (
          src &&
          (!Number.isInteger(src.next_id) ||
            src.next_id < 900000000 ||
            src.next_id > 1000000000)
        )
          throw Error("Invalid imported ID high-water mark");
        const max =
          (
            await db
              .prepare(
                `SELECT MAX(id) AS n FROM ${table} WHERE id BETWEEN 900000000 AND 999999999`,
              )
              .get()
          ).n ?? 899999999;
        const current = (
            await db
              .prepare(
                "SELECT next_id FROM creator_id_allocations WHERE kind=?",
              )
              .get(kind)
          ).next_id,
          next = Math.max(current, src?.next_id ?? 900000000, max + 1);
        if (next !== current) {
          await db
            .prepare("UPDATE creator_id_allocations SET next_id=? WHERE kind=?")
            .run(next, kind);
          counts.creator_id_allocations++;
        }
      }
      if (
        sourceAllocations.some(
          (row) => !["story", "chapter"].includes(row.kind),
        )
      )
        throw Error("Invalid allocation kind");
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
