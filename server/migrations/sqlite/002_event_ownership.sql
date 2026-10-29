ALTER TABLE listening_events RENAME TO legacy_listening_events_v0;
CREATE TABLE listening_events (
 event_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 story_id INTEGER NOT NULL REFERENCES stories(id), chapter_id INTEGER REFERENCES chapters(id),
 event_type TEXT NOT NULL CHECK(event_type IN ('playback_started','playback_paused','chapter_completed','story_favorited','listening_interval')),
 listening_seconds REAL NOT NULL DEFAULT 0 CHECK(listening_seconds>=0 AND listening_seconds<=60),
 metadata TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(user_id,event_id)
);
INSERT INTO users(id,display_name,kind) SELECT DISTINCT user_id,'Imported legacy listener','legacy' FROM legacy_listening_events_v0 WHERE 1 ON CONFLICT DO NOTHING;
INSERT INTO listening_events SELECT * FROM legacy_listening_events_v0;
CREATE INDEX owned_events_user_time_idx ON listening_events(user_id,created_at DESC);
CREATE INDEX owned_events_story_idx ON listening_events(user_id,story_id);
