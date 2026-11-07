CREATE TABLE user_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 playback_speed REAL NOT NULL DEFAULT 1 CHECK(playback_speed IN (0.75,1,1.25,1.5,2)),
 autoplay_next INTEGER NOT NULL DEFAULT 1 CHECK(autoplay_next IN (0,1)),
 default_volume REAL NOT NULL DEFAULT 0.8 CHECK(default_volume BETWEEN 0 AND 1),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
