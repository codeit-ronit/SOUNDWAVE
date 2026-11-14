CREATE TABLE story_publications (
 story_id INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE RESTRICT,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','approved','published','unpublished','rejected','withdrawn','revoked')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 story_revision INTEGER NOT NULL,
 snapshot_hash TEXT NOT NULL DEFAULT '',
 terms_version TEXT,
 attested_by TEXT REFERENCES users(id),
 attested_at TEXT,
 submitted_at TEXT,
 decided_by TEXT REFERENCES users(id),
 decided_at TEXT,
 decision_code TEXT,
 decision_note TEXT NOT NULL DEFAULT '' CHECK(length(decision_note)<=1000),
 published_at TEXT,
 revoked_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX publication_pending_idx ON story_publications(state,story_id);
CREATE TABLE publication_chapters (
 story_id INTEGER NOT NULL REFERENCES story_publications(story_id) ON DELETE RESTRICT,
 chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE RESTRICT,
 chapter_revision INTEGER NOT NULL,
 chapter_number INTEGER NOT NULL CHECK(chapter_number>0),
 asset_id TEXT NOT NULL REFERENCES private_media_assets(id) ON DELETE RESTRICT,
 head_revision INTEGER NOT NULL,
 output_id TEXT NOT NULL REFERENCES private_media_outputs(id) ON DELETE RESTRICT,
 checksum TEXT NOT NULL CHECK(length(checksum)=64),
 PRIMARY KEY(story_id,chapter_id),
 UNIQUE(story_id,chapter_number)
);
CREATE INDEX publication_output_idx ON publication_chapters(output_id);
CREATE TABLE publication_audit (
 id TEXT PRIMARY KEY,
 story_id INTEGER NOT NULL REFERENCES story_publications(story_id) ON DELETE RESTRICT,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_kind TEXT NOT NULL DEFAULT 'account' CHECK(actor_kind IN ('account','operator')),
 terms_version TEXT,
 attested_at TEXT,
 action TEXT NOT NULL CHECK(action IN ('submit','withdraw','approve','reject','publish','unpublish','revoke','suspend','deactivate')),
 revision INTEGER NOT NULL,
 snapshot_hash TEXT NOT NULL,
 decision_code TEXT,
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 created_at TEXT NOT NULL,
 UNIQUE(story_id,revision)
);
CREATE INDEX publication_audit_story_idx ON publication_audit(story_id,revision DESC);
CREATE TABLE publication_receipts (
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_id TEXT NOT NULL,
 story_id INTEGER NOT NULL REFERENCES story_publications(story_id) ON DELETE RESTRICT,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 PRIMARY KEY(actor_id,request_id)
);
