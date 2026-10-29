INSERT INTO users(id,display_name,kind)
 SELECT user_id,'Imported legacy listener','legacy' FROM favorites
 UNION SELECT user_id,'Imported legacy listener','legacy' FROM listening_progress
 UNION SELECT user_id,'Imported legacy listener','legacy' FROM progress_write_versions WHERE 1
 ON CONFLICT DO NOTHING;
CREATE TRIGGER favorites_owner_insert BEFORE INSERT ON favorites WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER favorites_owner_update BEFORE UPDATE OF user_id ON favorites WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER progress_owner_insert BEFORE INSERT ON listening_progress WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER progress_owner_update BEFORE UPDATE OF user_id ON listening_progress WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER versions_owner_insert BEFORE INSERT ON progress_write_versions WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER versions_owner_update BEFORE UPDATE OF user_id ON progress_write_versions WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Unknown owner'); END;
CREATE TRIGGER preserve_owned_rows BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM favorites WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM listening_progress WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM progress_write_versions WHERE user_id=OLD.id) BEGIN SELECT RAISE(ABORT,'User owns listening records'); END;
