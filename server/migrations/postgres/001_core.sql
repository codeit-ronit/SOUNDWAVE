CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('registered','guest','legacy')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((kind='registered' AND email IS NOT NULL AND password_hash IS NOT NULL AND email=lower(email))
      OR (kind IN ('guest','legacy') AND email IS NULL AND password_hash IS NULL))
);
INSERT INTO users(id,display_name,kind) VALUES ('demo-user','Legacy demo data','legacy');
CREATE TABLE stories (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL, author TEXT NOT NULL,
  tagline TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL, symbol TEXT NOT NULL, popularity INTEGER NOT NULL
);
CREATE INDEX stories_genre_idx ON stories(lower(genre));
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id),
  chapter_number INTEGER NOT NULL CHECK(chapter_number>0), title TEXT NOT NULL,
  audio_url TEXT NOT NULL, duration_seconds DOUBLE PRECISION NOT NULL CHECK(duration_seconds>0),
  UNIQUE(story_id,chapter_number), UNIQUE(story_id,id)
);
CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id), story_id INTEGER NOT NULL REFERENCES stories(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,story_id)
);
CREATE INDEX favorites_recency_idx ON favorites(user_id,created_at DESC);
CREATE TABLE listening_progress (
  user_id TEXT NOT NULL REFERENCES users(id), chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  position_seconds DOUBLE PRECISION NOT NULL CHECK(position_seconds>=0 AND position_seconds<'Infinity'::float8),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)), updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,chapter_id)
);
CREATE INDEX progress_recency_idx ON listening_progress(user_id,updated_at DESC);
CREATE TABLE progress_write_versions (
  user_id TEXT NOT NULL REFERENCES users(id), chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  client_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),
  PRIMARY KEY(user_id,chapter_id,client_id)
);
CREATE TABLE listening_events (
  event_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  story_id INTEGER NOT NULL REFERENCES stories(id), chapter_id INTEGER REFERENCES chapters(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('playback_started','playback_paused','chapter_completed','story_favorited','listening_interval')),
  listening_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(listening_seconds BETWEEN 0 AND 60),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata::jsonb)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,event_id),
  FOREIGN KEY(story_id,chapter_id) REFERENCES chapters(story_id,id)
);
CREATE INDEX events_user_time_idx ON listening_events(user_id,created_at DESC,event_order DESC);
CREATE INDEX events_story_idx ON listening_events(user_id,story_id);
