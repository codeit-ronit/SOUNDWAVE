CREATE TABLE playlists (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 next_position INTEGER NOT NULL DEFAULT 1 CHECK(next_position BETWEEN 1 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX playlists_owner_page_idx ON playlists(user_id,created_at DESC,id DESC);
CREATE TABLE playlist_items (
 playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
 story_id INTEGER NOT NULL REFERENCES stories(id),
 position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 9007199254740991),
 added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(playlist_id,story_id), UNIQUE(playlist_id,position)
);
CREATE INDEX playlist_items_story_idx ON playlist_items(story_id);
