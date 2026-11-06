CREATE TABLE story_sources (
 story_id INTEGER PRIMARY KEY REFERENCES stories(id), provider TEXT NOT NULL CHECK(provider='librivox'),
 external_id INTEGER NOT NULL UNIQUE CHECK(external_id BETWEEN 1 AND 1000000),
 source_url TEXT NOT NULL, archive_identifier TEXT NOT NULL UNIQUE,
 narrator TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 refreshed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX story_sources_refresh_idx ON story_sources(refreshed_at);
CREATE TABLE chapter_sources (
 chapter_id INTEGER PRIMARY KEY REFERENCES chapters(id), external_id INTEGER NOT NULL UNIQUE CHECK(external_id>0),
 audio_url TEXT NOT NULL, byte_length BIGINT NOT NULL CHECK(byte_length BETWEEN 100 AND 104857600),
 content_type TEXT NOT NULL CHECK(content_type='audio/mpeg'), file_md5 TEXT NOT NULL CHECK(length(file_md5)=32)
);
