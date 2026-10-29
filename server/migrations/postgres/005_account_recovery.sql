ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
CREATE TABLE account_tokens (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX account_tokens_user_idx ON account_tokens(user_id,purpose);
CREATE INDEX account_tokens_expiry_idx ON account_tokens(expires_at);
