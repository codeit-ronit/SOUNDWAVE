import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog } from "./content/catalog.js";
export const DEMO_USER = "demo-user";
export const defaultDatabasePath = fileURLToPath(
  new URL("./data/soundwave.sqlite", import.meta.url),
);

export function openDatabase(
  path = process.env.DATABASE_PATH || defaultDatabasePath,
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL,
      author TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
      color TEXT NOT NULL, symbol TEXT NOT NULL, popularity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id),
      chapter_number INTEGER NOT NULL, title TEXT NOT NULL, audio_url TEXT NOT NULL,
      duration_seconds REAL NOT NULL CHECK(duration_seconds > 0),
      UNIQUE(story_id, chapter_number)
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL, story_id INTEGER NOT NULL REFERENCES stories(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY(user_id, story_id)
    );
    CREATE TABLE IF NOT EXISTS listening_progress (
      user_id TEXT NOT NULL, chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      position_seconds REAL NOT NULL CHECK(position_seconds >= 0),
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY(user_id, chapter_id)
    );
    CREATE TABLE IF NOT EXISTS progress_write_versions (
      user_id TEXT NOT NULL, chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      client_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
      PRIMARY KEY(user_id, chapter_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS listening_events (
      event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      story_id INTEGER NOT NULL REFERENCES stories(id), chapter_id INTEGER REFERENCES chapters(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('playback_started','playback_paused','chapter_completed','story_favorited','listening_interval')),
      listening_seconds REAL NOT NULL DEFAULT 0 CHECK(listening_seconds >= 0 AND listening_seconds <= 60),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS events_user_time_idx ON listening_events(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS events_story_idx ON listening_events(user_id,story_id);
    CREATE INDEX IF NOT EXISTS chapters_story_idx ON chapters(story_id);
    CREATE INDEX IF NOT EXISTS progress_recency_idx ON listening_progress(user_id, updated_at DESC);
  `);
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const dir = new URL("./migrations/sqlite/", import.meta.url);
    for (const version of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(new URL(version, dir), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
        .get(version);
      if (old) {
        if (old.checksum !== checksum)
          throw Error(`Migration checksum mismatch: ${version}`);
        continue;
      }
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        version,
        checksum,
        new Date().toISOString(),
      );
    }
  })();
  return db;
}

export function seedDatabase(db) {
  const manifest = JSON.parse(
    readFileSync(
      new URL("./public/audio/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const insertStory =
    db.prepare(`INSERT INTO stories (id,title,genre,author,tagline,description,color,symbol,popularity)
    VALUES (@id,@title,@genre,@author,@tagline,@description,@color,@symbol,@popularity)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, genre=excluded.genre, author=excluded.author,
    tagline=excluded.tagline, description=excluded.description, color=excluded.color, symbol=excluded.symbol, popularity=excluded.popularity`);
  const insertChapter =
    db.prepare(`INSERT INTO chapters (id,story_id,chapter_number,title,audio_url,duration_seconds)
    VALUES (@id,@story_id,@chapter_number,@title,@audio_url,@duration_seconds)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, audio_url=excluded.audio_url, duration_seconds=excluded.duration_seconds`);
  db.transaction(() => {
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_revision'",
        )
        .get()
    )
      db.prepare("UPDATE catalog_revision SET revision=? WHERE id=1").run(
        randomUUID(),
      );
    for (const story of catalog) {
      const { chapters, ...row } = story;
      insertStory.run(row);
      chapters.forEach((chapter, index) => {
        const audio = manifest[`${story.id}-${index + 1}`];
        insertChapter.run({
          id: story.id * 100 + index + 1,
          story_id: story.id,
          chapter_number: index + 1,
          title: chapter.title,
          audio_url: audio.audioUrl,
          duration_seconds: audio.durationSeconds,
        });
      });
    }
  })();
}

export const storySelect = `SELECT s.*,
  (SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS chapter_count,
  (SELECT SUM(duration_seconds) FROM chapters c WHERE c.story_id=s.id) AS duration_seconds,
  EXISTS(SELECT 1 FROM favorites f WHERE f.story_id=s.id AND f.user_id=@user) AS is_favorite
  FROM stories s`;
export function serializeStory(row) {
  return { ...row, is_favorite: Boolean(row.is_favorite) };
}
export function serializeProgress(row) {
  return { ...row, completed: Boolean(row.completed) };
}
