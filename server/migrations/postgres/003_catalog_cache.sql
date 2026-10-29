CREATE TABLE catalog_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL);
INSERT INTO catalog_revision(id,revision) VALUES(1,'initial');
