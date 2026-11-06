CREATE TABLE oauth_identities (
 provider TEXT NOT NULL CHECK(provider='google'), subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
);
CREATE TABLE oauth_challenges (
 session_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 nonce_hash TEXT NOT NULL UNIQUE CHECK(length(nonce_hash)=64), expires_at TEXT NOT NULL
);
CREATE INDEX oauth_challenges_expiry_idx ON oauth_challenges(expires_at);
