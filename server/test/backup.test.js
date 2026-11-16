import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { backupDatabase, verifyBackup } from "../operations/backup.js";
if (process.env.TEST_DATABASE_URL && process.env.TEST_BACKUP_CONTAINER) {
  test("real PostgreSQL backup restores all 32 public table fingerprints and never overwrites its archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soundwave-backup-")),
      path = join(dir, "database.dump"),
      options = { container: process.env.TEST_BACKUP_CONTAINER };
    const client = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
      owner = randomUUID(),
      playlist = randomUUID();
    await client.connect();
    try {
      await client.query(
        "INSERT INTO users(id,display_name,kind,email,password_hash,platform_role) VALUES($1,$2,'registered',$3,'fixture-only-hash','moderator')",
        [owner, "Backup creator fixture", `backup-${owner}@example.com`],
      );
      await client.query(
        "INSERT INTO creator_profiles(user_id,display_name,bio,status) VALUES($1,'Restored creator','Retained private bio','suspended')",
        [owner],
      );
      await client.query(
        "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity,ownership_kind,owner_id) VALUES(900000000,'Private backup fixture','Test','Owner','','','#abc','radio',0,'creator',$1)",
        [owner],
      );
      await client.query(
        "INSERT INTO playlists(id,user_id,name,next_position) VALUES($1,$2,$3,2)",
        [playlist, owner, "Restored collection"],
      );
      await client.query(
        "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES($1,1,1)",
        [playlist],
      );
      await client.query(
        "INSERT INTO user_preferences(user_id,playback_speed,autoplay_next,default_volume) VALUES($1,1.5,0,0.4)",
        [owner],
      );
      await client.query(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,revision) VALUES($1,101,6,3)",
        [owner],
      );
      await client.query(
        "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,ack_updated_at) VALUES($1,101,$2,9,$3,3,6,0,CURRENT_TIMESTAMP)",
        [owner, randomUUID(), "a".repeat(64)],
      );
      await client.query(
        "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,result_code) VALUES($1,101,$2,10,$3,3,6,0,'PROGRESS_CONFLICT')",
        [owner, randomUUID(), "b".repeat(64)],
      );
      await client.query("UPDATE users SET history_revision=9 WHERE id=$1", [
        owner,
      ]);
      await client.query(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,completed,revision,history_removed) SELECT $1,102,duration_seconds,1,7,1 FROM chapters WHERE id=102",
        [owner],
      );
      await client.query(
        "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds,draft_removed,draft_revision,summary) VALUES(900000000,900000000,1000,'Removed draft','',1,1,7,'Preserved summary')",
      );
      await client.query(
        "UPDATE stories SET draft_state='archived',draft_revision=5,language='hi' WHERE id=900000000 AND owner_id=$1",
        [owner],
      );
      await client.query(
        "UPDATE creator_id_allocations SET next_id=GREATEST(next_id,900000001)",
      );
      await client.query(
        "INSERT INTO draft_create_receipts(user_id,request_id,request_hash,kind,story_id,chapter_id) VALUES($1,$2,$3,'chapter',900000000,900000000)",
        [owner, randomUUID(), "c".repeat(64)],
      );
      const mediaId = randomUUID();
      await client.query(
        "INSERT INTO private_media_assets(id,user_id,story_id,chapter_id,request_id,request_hash,object_key,status,reserved_bytes,byte_size,checksum,detected_type,duration_seconds,validation_version,expected_chapter_revision,expected_head_revision,expires_at) VALUES($1,$2,900000000,900000000,$3,$4,$5,'validated',44,44,$4,'audio/wav',1,1,7,0,CURRENT_TIMESTAMP)",
        [mediaId, owner, randomUUID(), "d".repeat(64), "e".repeat(64)],
      );
      await client.query(
        "INSERT INTO private_media_heads(chapter_id,story_id,user_id,asset_id,revision) VALUES(900000000,900000000,$1,$2,1)",
        [owner, mediaId],
      );
      const intent = randomUUID(),
        output = randomUUID();
      await client.query(
        "INSERT INTO private_processing_intents(id,asset_id,user_id,story_id,chapter_id,source_hash,processor_version,job_key,status,stage,source_revision,head_revision,chapter_revision,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,900000000,900000000,$4,1,$5,'ready','ready',1,1,7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        [
          intent,
          mediaId,
          owner,
          "d".repeat(64),
          "private-audio:" + mediaId + ":" + "d".repeat(64) + ":processor-v1",
        ],
      );
      await client.query(
        "INSERT INTO private_media_outputs(id,intent_id,object_key,fence_token,status,reserved_bytes,byte_size,checksum,format,duration_seconds,sample_rate,channels,created_at) VALUES($1,$2,$3,$4,'ready',1024,1024,$3,'mp3',1,44100,2,CURRENT_TIMESTAMP)",
        [output, intent, "f".repeat(64), randomUUID()],
      );
      await client.query(
        "INSERT INTO story_publications(story_id,state,revision,story_revision,snapshot_hash,updated_at) VALUES(900000000,'withdrawn',1,5,$1,CURRENT_TIMESTAMP)",
        ["a".repeat(64)],
      );
      await client.query(
        "INSERT INTO publication_chapters(story_id,chapter_id,chapter_revision,chapter_number,asset_id,head_revision,output_id,checksum) VALUES(900000000,900000000,7,1000,$1,1,$2,$3)",
        [mediaId, output, "f".repeat(64)],
      );
      await client.query(
        "INSERT INTO publication_audit(id,story_id,actor_id,action,revision,snapshot_hash,created_at) VALUES($1,900000000,$2,'withdraw',1,$3,CURRENT_TIMESTAMP)",
        [randomUUID(), owner, "a".repeat(64)],
      );
      await client.query(
        "INSERT INTO publication_receipts(actor_id,request_id,story_id,request_hash) VALUES($1,$2,900000000,$3)",
        [owner, randomUUID(), "b".repeat(64)],
      );
      const dispatch = randomUUID();
      await client.query(
        "INSERT INTO background_jobs(id,kind,dedupe_key,owner_id,payload,status,dispatch_topic,completed_at) VALUES($1,'maintenance',$2,$3,$4,'completed','private_audio',CURRENT_TIMESTAMP)",
        [
          dispatch,
          "private-audio:" + mediaId + ":" + "d".repeat(64) + ":processor-v1",
          owner,
          JSON.stringify({ intentId: intent }),
        ],
      );
      await client.query(
        "UPDATE private_processing_intents SET outbox_id=$1 WHERE id=$2",
        [dispatch, intent],
      );
      const manifest = await backupDatabase(
        process.env.TEST_DATABASE_URL,
        path,
        options,
      );
      assert.equal(Object.keys(manifest.tables).length, 32);
      assert.ok(manifest.tables.user_preferences.count > 0);
      assert.ok(manifest.tables.creator_profiles.count > 0);
      assert.ok(manifest.tables.private_media_assets.count > 0);
      assert.ok(manifest.tables.private_media_heads.count > 0);
      assert.ok(manifest.tables.private_processing_intents.count > 0);
      assert.ok(manifest.tables.private_media_outputs.count > 0);
      for (const table of [
        "story_publications",
        "publication_chapters",
        "publication_audit",
        "publication_receipts",
      ])
        assert.ok(manifest.tables[table].count > 0);
      assert.ok(manifest.tables.creator_id_allocations.count >= 2);
      assert.ok(manifest.tables.draft_create_receipts.count > 0);
      assert.ok(manifest.tables.listening_progress.count > 0);
      assert.ok(manifest.tables.progress_write_versions.count > 0);
      assert.ok(manifest.tables.playlists.count > 0);
      assert.ok(manifest.tables.playlist_items.count > 0);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path + ".json").mode & 0o777, 0o600);
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 32 },
      );
      // Older version-1 manifests covered the previous 21-table inventory.
      // Verify that allowlisted legacy inventory is accepted, without weakening
      // the full 22-table comparison above or accepting arbitrary table names.
      const manifestPath = path + ".json",
        original = readFileSync(manifestPath, "utf8"),
        legacy = JSON.parse(original);
      for (const table of [
        "story_publications",
        "publication_chapters",
        "publication_audit",
        "publication_receipts",
      ])
        delete legacy.tables[table];
      delete legacy.tables.private_media_outputs;
      delete legacy.tables.private_processing_intents;
      delete legacy.tables.private_media_heads;
      delete legacy.tables.private_media_assets;
      delete legacy.tables.creator_profiles;
      delete legacy.tables.creator_id_allocations;
      delete legacy.tables.draft_create_receipts;
      writeFileSync(manifestPath, JSON.stringify(legacy));
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 21 },
      );
      legacy.tables.injected = { count: "0", fingerprint: "0" };
      writeFileSync(manifestPath, JSON.stringify(legacy));
      await assert.rejects(
        verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        /Unsupported backup table manifest/,
      );
      writeFileSync(manifestPath, original);
      const size = statSync(path).size;
      await assert.rejects(
        backupDatabase(process.env.TEST_DATABASE_URL, path, options),
        /EEXIST/,
      );
      assert.equal(statSync(path).size, size);
    } finally {
      try {
        await client.query(
          "DELETE FROM progress_write_versions WHERE user_id=$1",
          [owner],
        );
        await client.query("DELETE FROM listening_progress WHERE user_id=$1", [
          owner,
        ]);
        await client.query(
          "DELETE FROM draft_create_receipts WHERE user_id=$1",
          [owner],
        );
        for (const table of [
          "publication_receipts",
          "publication_audit",
          "publication_chapters",
          "story_publications",
        ])
          await client.query(`DELETE FROM ${table} WHERE story_id=900000000`);
        await client.query(
          "DELETE FROM private_media_outputs WHERE intent_id IN (SELECT id FROM private_processing_intents WHERE user_id=$1)",
          [owner],
        );
        await client.query(
          "DELETE FROM private_processing_intents WHERE user_id=$1",
          [owner],
        );
        await client.query("DELETE FROM private_media_heads WHERE user_id=$1", [
          owner,
        ]);
        await client.query(
          "DELETE FROM private_media_assets WHERE user_id=$1",
          [owner],
        );
        await client.query("DELETE FROM chapters WHERE story_id=900000000");
        await client.query(
          "DELETE FROM stories WHERE id=900000000 AND owner_id=$1",
          [owner],
        );
        await client.query("DELETE FROM background_jobs WHERE owner_id=$1", [
          owner,
        ]);
        await client.query("DELETE FROM users WHERE id=$1", [owner]);
      } finally {
        await client.end();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  test("tampered archives fail integrity verification before any restore database is created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soundwave-backup-tamper-")),
      path = join(dir, "database.dump"),
      options = { container: process.env.TEST_BACKUP_CONTAINER };
    try {
      await backupDatabase(process.env.TEST_DATABASE_URL, path, options);
      const bytes = readFileSync(path);
      bytes[0] ^= 1;
      writeFileSync(path, bytes);
      await assert.rejects(
        verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        /integrity/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
