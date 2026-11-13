ALTER TABLE background_jobs ADD COLUMN dispatch_topic TEXT CHECK(dispatch_topic IS NULL OR (dispatch_topic='private_audio' AND kind='maintenance' AND owner_id IS NOT NULL));
CREATE UNIQUE INDEX processing_asset_binding_idx ON private_media_assets(id,user_id,story_id,chapter_id);
CREATE TABLE private_processing_intents (
 id TEXT PRIMARY KEY CHECK(length(id)=36), asset_id TEXT NOT NULL UNIQUE REFERENCES private_media_assets(id),
 user_id TEXT NOT NULL REFERENCES users(id), story_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64), processor_version INTEGER NOT NULL CHECK(processor_version>=1),
 job_key TEXT NOT NULL UNIQUE, outbox_id TEXT REFERENCES background_jobs(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed','superseded','deleted')),
 stage TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 10), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 40),
 cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cycle_attempts BETWEEN 0 AND 4),
 source_revision INTEGER NOT NULL, head_revision INTEGER NOT NULL, chapter_revision INTEGER NOT NULL,
 lease_token TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL,
 checked_at TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
 FOREIGN KEY(asset_id,user_id,story_id,chapter_id) REFERENCES private_media_assets(id,user_id,story_id,chapter_id),
 FOREIGN KEY(story_id,user_id) REFERENCES stories(id,owner_id), FOREIGN KEY(story_id,chapter_id) REFERENCES chapters(story_id,id),
 CHECK(status<>'processing' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX processing_recovery_idx ON private_processing_intents(status,next_attempt_at,lease_until);
CREATE INDEX processing_owner_idx ON private_processing_intents(user_id);
CREATE TABLE private_media_outputs (
 id TEXT PRIMARY KEY CHECK(length(id)=36), intent_id TEXT NOT NULL REFERENCES private_processing_intents(id),
 object_key TEXT NOT NULL UNIQUE CHECK(length(object_key)=64), fence_token TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('writing','ready','orphan','deleted')),
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 16777216), byte_size INTEGER, checksum TEXT CHECK(length(checksum)=64),
 format TEXT, duration_seconds REAL, sample_rate INTEGER, channels INTEGER,
 lease_until TEXT, storage_released INTEGER NOT NULL DEFAULT 0 CHECK(storage_released IN (0,1)), cleanup_error INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_error IN (0,1)),
 created_at TEXT NOT NULL, completed_at TEXT,
 CHECK(status<>'ready' OR (format='mp3' AND byte_size>0 AND byte_size<=reserved_bytes AND checksum IS NOT NULL AND duration_seconds>0 AND sample_rate=44100 AND channels=2))
);
CREATE UNIQUE INDEX processing_ready_output_idx ON private_media_outputs(intent_id) WHERE status='ready';
CREATE INDEX processing_output_cleanup_idx ON private_media_outputs(status,lease_until,storage_released);

-- Upgrade existing current validated WAVs without treating validation as processing.
INSERT INTO private_processing_intents(id,asset_id,user_id,story_id,chapter_id,source_hash,processor_version,job_key,source_revision,head_revision,chapter_revision,next_attempt_at,created_at,updated_at)
SELECT a.id,a.id,a.user_id,a.story_id,a.chapter_id,a.checksum,1,'private-audio:'||a.id||':'||a.checksum||':processor-v1',a.revision,h.revision,c.draft_revision,'1970-01-01T00:00:00.000Z',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM private_media_assets a JOIN private_media_heads h ON h.asset_id=a.id JOIN chapters c ON c.id=a.chapter_id JOIN stories s ON s.id=a.story_id
WHERE a.status='validated' AND s.draft_state='draft' AND c.draft_removed=0;
INSERT INTO background_jobs(id,kind,dedupe_key,owner_id,payload,available_at,created_at,max_attempts,dispatch_topic)
SELECT id,'maintenance',job_key,user_id,'{"intentId":"'||id||'"}','1970-01-01T00:00:00.000Z',CURRENT_TIMESTAMP,5,'private_audio' FROM private_processing_intents WHERE 1=1 ON CONFLICT(dedupe_key) DO NOTHING;
UPDATE private_processing_intents SET outbox_id=(SELECT id FROM background_jobs WHERE dedupe_key=private_processing_intents.job_key);
