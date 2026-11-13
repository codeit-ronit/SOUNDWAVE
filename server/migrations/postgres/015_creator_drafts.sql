ALTER TABLE stories ADD COLUMN draft_state TEXT NOT NULL DEFAULT 'draft' CHECK(draft_state IN ('draft','archived'));
ALTER TABLE stories ADD COLUMN draft_revision BIGINT NOT NULL DEFAULT 1 CHECK(draft_revision BETWEEN 1 AND 9007199254740991);
ALTER TABLE stories ADD COLUMN language TEXT NOT NULL DEFAULT 'und' CHECK(length(language) BETWEEN 2 AND 6);
ALTER TABLE chapters ADD COLUMN draft_revision BIGINT NOT NULL DEFAULT 1 CHECK(draft_revision BETWEEN 1 AND 9007199254740991);
ALTER TABLE chapters ADD COLUMN draft_removed INTEGER NOT NULL DEFAULT 0 CHECK(draft_removed IN (0,1));
ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '' CHECK(length(summary)<=2000);
CREATE INDEX creator_drafts_list_idx ON stories(owner_id,id DESC) WHERE ownership_kind='creator';
CREATE INDEX draft_chapter_order_idx ON chapters(story_id,draft_removed,chapter_number);
CREATE TABLE creator_id_allocations (
 kind TEXT PRIMARY KEY CHECK(kind IN ('story','chapter')),
 next_id BIGINT NOT NULL CHECK(next_id BETWEEN 900000000 AND 1000000000)
);
INSERT INTO creator_id_allocations(kind,next_id) SELECT 'story',CASE WHEN COALESCE(MAX(id),899999999)<900000000 THEN 900000000 ELSE MAX(id)+1 END FROM stories WHERE id BETWEEN 900000000 AND 999999999;
INSERT INTO creator_id_allocations(kind,next_id) SELECT 'chapter',CASE WHEN COALESCE(MAX(id),899999999)<900000000 THEN 900000000 ELSE MAX(id)+1 END FROM chapters WHERE id BETWEEN 900000000 AND 999999999;
CREATE UNIQUE INDEX draft_story_owner_key ON stories(id,owner_id);
CREATE TABLE draft_create_receipts (
 user_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 kind TEXT NOT NULL CHECK(kind IN ('story','chapter')),
 story_id INTEGER NOT NULL,
 chapter_id INTEGER,
 PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(story_id,user_id) REFERENCES stories(id,owner_id),
 FOREIGN KEY(story_id,chapter_id) REFERENCES chapters(story_id,id),
 CHECK((kind='story' AND chapter_id IS NULL) OR (kind='chapter' AND chapter_id IS NOT NULL))
);
CREATE INDEX draft_receipts_story_idx ON draft_create_receipts(story_id);
