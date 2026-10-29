CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, display_name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('registered','guest','legacy')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK ((kind='registered' AND email IS NOT NULL AND password_hash IS NOT NULL AND email=lower(email)) OR (kind IN ('guest','legacy') AND email IS NULL AND password_hash IS NULL))
);
INSERT INTO users(id,display_name,kind) VALUES ('demo-user','Legacy demo data','legacy') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
