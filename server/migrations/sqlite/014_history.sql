ALTER TABLE users ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0 CHECK(history_revision>=0 AND history_revision<=9007199254740991);
ALTER TABLE listening_progress ADD COLUMN history_removed INTEGER NOT NULL DEFAULT 0 CHECK(history_removed IN(0,1));
CREATE INDEX progress_history_idx ON listening_progress(user_id,updated_at DESC,chapter_id DESC) WHERE history_removed=0;
