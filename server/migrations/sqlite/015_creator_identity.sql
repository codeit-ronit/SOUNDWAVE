ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'listener' CHECK(platform_role IN ('listener','moderator','admin') AND (platform_role='listener' OR kind='registered'));
CREATE UNIQUE INDEX users_identity_kind_idx ON users(id,kind);
CREATE TABLE creator_profiles (
 user_id TEXT PRIMARY KEY NOT NULL,
 account_kind TEXT NOT NULL DEFAULT 'registered' CHECK(account_kind='registered'),
 display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 80),
 bio TEXT NOT NULL DEFAULT '' CHECK(length(bio)<=1000),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','suspended')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(user_id,account_kind) REFERENCES users(id,kind) ON DELETE CASCADE
);
CREATE INDEX creators_status_idx ON creator_profiles(status,user_id);
ALTER TABLE stories ADD COLUMN owner_id TEXT REFERENCES creator_profiles(user_id) ON DELETE RESTRICT;
ALTER TABLE stories ADD COLUMN ownership_kind TEXT NOT NULL DEFAULT 'system' CHECK((ownership_kind='creator' AND owner_id IS NOT NULL) OR (ownership_kind IN ('system','external') AND owner_id IS NULL));
UPDATE stories SET ownership_kind='external' WHERE EXISTS(SELECT 1 FROM story_sources x WHERE x.story_id=stories.id);
CREATE INDEX stories_owner_idx ON stories(owner_id,id) WHERE owner_id IS NOT NULL;
