CREATE TABLE private_media_assets (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL REFERENCES users(id), story_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36), request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 object_key TEXT NOT NULL UNIQUE CHECK(length(object_key)=64),
 status TEXT NOT NULL CHECK(status IN ('reserved','uploading','quarantined','validated','failed','deleted')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 reserved_bytes BIGINT NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 52428800),
 byte_size BIGINT CHECK(byte_size BETWEEN 1 AND 52428800), checksum TEXT CHECK(length(checksum)=64), detected_type TEXT,
 duration_seconds DOUBLE PRECISION, validation_version INTEGER,
 expected_chapter_revision BIGINT NOT NULL CHECK(expected_chapter_revision>=1), expected_head_revision BIGINT NOT NULL CHECK(expected_head_revision>=0),
 lease_token TEXT, lease_until TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL,
 storage_released INTEGER NOT NULL DEFAULT 0 CHECK(storage_released IN (0,1)),
 error_code TEXT, cleanup_error INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_error IN (0,1)),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,request_id), UNIQUE(chapter_id,id),
 FOREIGN KEY(story_id,user_id) REFERENCES stories(id,owner_id),
 FOREIGN KEY(story_id,chapter_id) REFERENCES chapters(story_id,id),
 CHECK(status<>'validated' OR (checksum IS NOT NULL AND detected_type='audio/wav' AND byte_size=reserved_bytes AND duration_seconds>0 AND validation_version=1))
);
CREATE UNIQUE INDEX private_media_inflight_idx ON private_media_assets(chapter_id) WHERE status IN ('reserved','uploading','quarantined');
CREATE INDEX private_media_quota_idx ON private_media_assets(user_id,storage_released);
CREATE INDEX private_media_cleanup_idx ON private_media_assets(status,updated_at);
CREATE TABLE private_media_heads (
 chapter_id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL, user_id TEXT NOT NULL,
 asset_id TEXT, revision BIGINT NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(story_id,user_id) REFERENCES stories(id,owner_id),
 FOREIGN KEY(story_id,chapter_id) REFERENCES chapters(story_id,id),
 FOREIGN KEY(chapter_id,asset_id) REFERENCES private_media_assets(chapter_id,id)
);
CREATE INDEX private_media_heads_owner_idx ON private_media_heads(user_id);
