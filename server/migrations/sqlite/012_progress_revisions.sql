ALTER TABLE listening_progress ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0 AND revision<=9007199254740991);
ALTER TABLE progress_write_versions ADD COLUMN request_hash TEXT CHECK(request_hash IS NULL OR length(request_hash)=64);
ALTER TABLE progress_write_versions ADD COLUMN accepted_revision INTEGER NOT NULL DEFAULT 0 CHECK(accepted_revision>=0 AND accepted_revision<=9007199254740991);
ALTER TABLE progress_write_versions ADD COLUMN ack_position REAL NOT NULL DEFAULT 0 CHECK(ack_position>=0);
ALTER TABLE progress_write_versions ADD COLUMN ack_completed INTEGER NOT NULL DEFAULT 0 CHECK(ack_completed IN(0,1));
ALTER TABLE progress_write_versions ADD COLUMN ack_updated_at TEXT;
