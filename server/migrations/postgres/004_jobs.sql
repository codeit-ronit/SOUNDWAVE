CREATE TABLE background_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('analytics_rollup','maintenance','send_email')),
 dedupe_key TEXT NOT NULL UNIQUE, owner_id TEXT REFERENCES users(id), payload TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','dead')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
 available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_until TIMESTAMPTZ, locked_by TEXT,
 last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMPTZ
);
CREATE INDEX jobs_ready_idx ON background_jobs(status,available_at);
CREATE INDEX jobs_lease_idx ON background_jobs(status,lease_until);
CREATE INDEX jobs_owner_idx ON background_jobs(owner_id);
CREATE TABLE analytics_rollups (
 user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, genre TEXT NOT NULL,
 listening_seconds DOUBLE PRECISION NOT NULL CHECK(listening_seconds>=0), interval_count INTEGER NOT NULL CHECK(interval_count>=0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,day,genre)
);
