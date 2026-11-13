import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setup, reserve } from "./private-media-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { backends } from "./phase2-helpers.js";
import { processPrivateMedia } from "../media/private-processor.js";
import {
  transcodePrivateWav,
  runBoundedMediaCommand,
} from "../media/private-ffmpeg.js";
import { processingIntents } from "../services/processing-intents.js";
import { provisionIdentity } from "../services/creator-operator.js";
async function uploaded(kind, config = {}) {
  const f = await setup(kind, {
      processingSeconds: 5,
      derivativeMaxBytes: 262144,
      ...config,
    }),
    b = wav(8000),
    a = (await reserve(f, b)).body.asset;
  await f.c
    .write("put", `${f.path}/${a.id}/bytes`, b)
    .set("Content-Type", "audio/wav")
    .expect(200);
  const p = await f.db
    .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
    .get(a.id);
  return {
    ...f,
    a,
    p,
    ps: processingIntents(f.db, f.config, f.service.storage),
    b,
  };
}
for (const kind of backends) {
  test(`${kind}: real FFmpeg private MP3 conversion is checked, playable and idempotent`, async () => {
    const f = await uploaded(kind);
    try {
      assert.equal(
        f.p.job_key,
        `private-audio:${f.a.id}:${createHash("sha256").update(f.b).digest("hex")}:processor-v1`,
      );
      const outbox = await f.db
        .prepare("SELECT * FROM background_jobs WHERE id=?")
        .get(f.p.outbox_id);
      assert.equal(outbox.dispatch_topic, "private_audio");
      assert.equal(outbox.status, "pending");
      const results = await Promise.all([
        processPrivateMedia(f.db, f.config, f.p.id),
        processPrivateMedia(f.db, f.config, f.p.id),
      ]);
      assert.equal(results.filter((r) => r.ready).length, 1);
      const state = (await f.c.get(f.path)).body;
      assert.equal(state.processingIntent.status, "ready");
      assert.equal(state.processingIntent.attempts, 1);
      assert.equal(state.derivative.format, "mp3");
      assert.equal(state.derivative.sampleRate, 44100);
      assert.equal(state.derivative.channels, 2);
      assert.ok(Math.abs(state.derivative.durationSeconds - 1) < 0.15);
      const bytes = (
        await f.c.get(`${f.path}/${f.a.id}/derivative`).expect(200)
      ).body;
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        state.derivative.checksum,
      );
      await f.c
        .get(`${f.path}/${f.a.id}/derivative`)
        .set("Range", "bytes=0-11")
        .expect(206);
      await f.c
        .get(`${f.path}/${f.a.id}/derivative`)
        .set("Range", "bytes=9999999-")
        .expect(416);
      await f.c.agent
        .head(`/api${f.path}/${f.a.id}/derivative`)
        .expect(200)
        .expect("Content-Type", /audio\/mpeg/);
      assert.deepEqual(
        (await f.c.get(`${f.path}/${f.a.id}/preview`)).body,
        f.b,
      );
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 2);
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      const other = await f.client();
      await other.get(`${f.path}/${f.a.id}/derivative`).expect(401);
      assert.equal(
        (await processPrivateMedia(f.db, f.config, f.p.id)).unchanged,
        true,
      );
      const oldOutput = await f.db
        .prepare(
          "SELECT * FROM private_media_outputs WHERE intent_id=? AND status='ready'",
        )
        .get(f.p.id);
      await writeFile(
        join(f.config.privateMediaRoot, oldOutput.object_key + ".blob"),
        Buffer.alloc(oldOutput.byte_size),
      );
      await f.c
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: state.processingIntent.revision,
        })
        .expect(200);
      await processPrivateMedia(f.db, f.config, f.p.id);
      assert.notEqual((await f.c.get(f.path)).body.derivative.id, oldOutput.id);
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 2);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: processing retries persist backoff and explicit retry is revision/owner guarded`, async () => {
    const f = await uploaded(kind);
    try {
      const failure = () => {
        throw Object.assign(Error("transient"), { code: "FFMPEG_TIMEOUT" });
      };
      await assert.rejects(
        processPrivateMedia(f.db, f.config, f.p.id, { converter: failure }),
      );
      let p = await f.ps.get(f.p.id);
      assert.equal(p.status, "pending");
      assert.equal(p.cycle_attempts, 1);
      assert.ok(p.next_attempt_at > p.updated_at);
      assert.equal(
        (await processPrivateMedia(f.db, f.config, f.p.id)).unchanged,
        true,
      );
      await f.db
        .prepare(
          "UPDATE private_processing_intents SET next_attempt_at=? WHERE id=?",
        )
        .run("2000-01-01T00:00:00.000Z", p.id);
      await processPrivateMedia(f.db, f.config, p.id);
      p = await f.ps.get(p.id);
      assert.equal(p.status, "ready");
      assert.equal(p.attempts, 2);
      await f.c
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: p.revision,
        })
        .expect(409);
      const second = await f.client();
      await second.auth("demo", {});
      await second
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: p.revision,
        })
        .expect(403);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: corrupted source fails visibly and restored bytes require explicit controlled retry`, async () => {
    const f = await uploaded(kind);
    try {
      const source = await f.db
        .prepare("SELECT * FROM private_media_assets WHERE id=?")
        .get(f.a.id);
      await writeFile(
        join(f.config.privateMediaRoot, source.object_key + ".blob"),
        Buffer.alloc(f.b.length),
      );
      await assert.rejects(
        processPrivateMedia(f.db, f.config, f.p.id),
        (e) => e.code === "SOURCE_HASH",
      );
      let p = await f.ps.get(f.p.id);
      assert.equal(p.status, "failed");
      assert.equal(p.error_code, "SOURCE_HASH");
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 1);
      await writeFile(
        join(f.config.privateMediaRoot, source.object_key + ".blob"),
        f.b,
      );
      await f.c
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: p.revision - 1,
        })
        .expect(409);
      await f.c
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: p.revision,
        })
        .expect(200);
      await processPrivateMedia(f.db, f.config, p.id);
      p = await f.ps.get(p.id);
      assert.equal(p.status, "ready");
      assert.equal(p.generation, 2);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: expired processing fences cannot publish or remove a newer immutable result`, async () => {
    const f = await uploaded(kind);
    try {
      const first = await f.ps.claim(f.p.id);
      const h = await f.service.storage.create(first.output.object_key);
      await h.write("old output");
      await h.close();
      await f.db
        .prepare(
          "UPDATE private_processing_intents SET lease_until=? WHERE id=?",
        )
        .run("2000-01-01T00:00:00.000Z", f.p.id);
      await f.db
        .prepare("UPDATE private_media_outputs SET lease_until=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", first.output.id);
      const second = await f.ps.claim(f.p.id);
      assert.notEqual(first.token, second.token);
      const m = await transcodePrivateWav(
        f.service.storage,
        second.source,
        second.output,
        f.config,
      );
      assert.equal(
        await f.ps.commit(f.p.id, second.token, second.output.id, m),
        true,
      );
      await assert.rejects(
        f.ps.commit(f.p.id, first.token, first.output.id, m),
        (e) => e.mediaCode === "STALE_PROCESSING",
      );
      await f.ps.release(f.p.id, first.token);
      await f.ps.sweep();
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 2);
      const state = (await f.c.get(f.path)).body;
      assert.equal(state.derivative.id, second.output.id);
      assert.equal(state.processingIntent.attempts, 2);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: replacement, deletion, archive and suspension cannot publish stale processing output`, async () => {
    for (const action of ["replace", "delete", "archive", "suspend"]) {
      const f = await uploaded(kind);
      try {
        const result = await processPrivateMedia(f.db, f.config, f.p.id, {
          hooks: {
            afterOutput: async () => {
              if (action === "replace") {
                const b = wav(4000),
                  a = (await reserve(f, b)).body.asset;
                await f.c
                  .write("put", `${f.path}/${a.id}/bytes`, b)
                  .set("Content-Type", "audio/wav")
                  .expect(200);
              }
              if (action === "delete")
                await f.c
                  .write("delete", `${f.path}/${f.a.id}`, {
                    expectedRevision: 4,
                  })
                  .expect(200);
              if (action === "archive")
                await f.c
                  .write("post", `/creator/stories/${f.s.id}/archive`, {
                    expectedRevision: f.s.revision,
                  })
                  .expect(200);
              if (action === "suspend")
                await provisionIdentity(
                  f.db,
                  "status",
                  f.c.data.user.id,
                  "suspended",
                );
            },
          },
        });
        assert.equal(result.ready, false);
        const p = await f.ps.get(f.p.id);
        assert.equal(p.status, action === "suspend" ? "failed" : "superseded");
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT COUNT(*) AS n FROM private_media_outputs WHERE intent_id=? AND status='ready'",
              )
              .get(p.id)
          ).n,
          0,
        );
        await f.c
          .get(`${f.path}/${f.a.id}/derivative`)
          .expect(action === "suspend" ? 403 : 404);
        await f.service.sweep();
      } finally {
        await f.close();
      }
    }
  });
  test(`${kind}: output limits, quota and stale chapter revisions fail safely without orphan growth`, async () => {
    const f = await uploaded(kind, { derivativeMaxBytes: 10 });
    try {
      for (let i = 1; i <= 4; i++) {
        await assert.rejects(processPrivateMedia(f.db, f.config, f.p.id));
        const p = await f.ps.get(f.p.id);
        assert.equal(p.attempts, i);
        if (i < 4) {
          assert.equal(p.status, "pending");
          await f.db
            .prepare(
              "UPDATE private_processing_intents SET next_attempt_at=? WHERE id=?",
            )
            .run("2000-01-01T00:00:00.000Z", p.id);
        } else assert.equal(p.status, "failed");
      }
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 1);
      assert.equal((await f.c.get(f.path)).body.usedBytes, f.b.length);
    } finally {
      await f.close();
    }
    const limited = await uploaded(kind, {
      derivativeMaxBytes: 262144,
      creatorStorageBytes: 20000,
    });
    try {
      await processPrivateMedia(limited.db, limited.config, limited.p.id);
      assert.equal(
        (await limited.ps.get(limited.p.id)).error_code,
        "STORAGE_QUOTA",
      );
      assert.equal(
        (
          await limited.db
            .prepare("SELECT COUNT(*) AS n FROM private_media_outputs")
            .get()
        ).n,
        0,
      );
    } finally {
      await limited.close();
    }
    const missing = await uploaded(kind, {
      ffmpegPath: "/nonexistent/soundwave-ffmpeg",
    });
    try {
      await assert.rejects(
        processPrivateMedia(missing.db, missing.config, missing.p.id),
        (e) => e.code === "FFMPEG_UNAVAILABLE",
      );
      assert.equal((await missing.ps.get(missing.p.id)).status, "failed");
      assert.equal((await readdir(missing.config.privateMediaRoot)).length, 1);
    } finally {
      await missing.close();
    }
  });
}
test("FFmpeg subprocess timeout terminates the child without a lingering process", async () => {
  await assert.rejects(
    runBoundedMediaCommand("/bin/sleep", ["5"], {
      config: { processingSeconds: 1, processingMemoryBytes: 268435456 },
    }),
    (e) => e.code === "FFMPEG_TIMEOUT",
  );
});
for (const kind of backends)
  test(`${kind}: additive processing migration backfills validated uploads and durable outbox atomically`, async () => {
    const f = await uploaded(kind);
    try {
      const { migrate } = await import("../database/migrate.js");
      await f.c.write("put", "/library/1").expect(200);
      const before = (await f.c.get(f.path)).body.current;
      await f.db.prepare("DROP TABLE private_media_outputs").run();
      await f.db.prepare("DROP TABLE private_processing_intents").run();
      await f.db.prepare("DROP INDEX processing_asset_binding_idx").run();
      await f.db
        .prepare(
          "DELETE FROM background_jobs WHERE dispatch_topic='private_audio'",
        )
        .run();
      await f.db
        .prepare("ALTER TABLE background_jobs DROP COLUMN dispatch_topic")
        .run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(
          kind === "postgres"
            ? "017_private_processing.sql"
            : "018_private_processing.sql",
        );
      await migrate(f.db);
      await migrate(f.db);
      const state = (await f.c.get(f.path)).body;
      assert.deepEqual(state.current, before);
      assert.equal(state.processingIntent.status, "pending");
      assert.equal(state.derivative, null);
      assert.equal((await f.c.get("/library")).body.stories.length, 1);
      const p = await f.db
          .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
          .get(f.a.id),
        job = await f.db
          .prepare("SELECT * FROM background_jobs WHERE id=?")
          .get(p.outbox_id);
      assert.equal(JSON.parse(job.payload).intentId, p.id);
      await processPrivateMedia(f.db, f.config, p.id);
      assert.equal(
        (await f.c.get(f.path)).body.processingIntent.status,
        "ready",
      );
    } finally {
      await f.close();
    }
  });
for (const kind of backends)
  test(`${kind}: invalid encoder output is rejected and chapter edits fence in-flight intent revisions`, async () => {
    const f = await uploaded(kind);
    try {
      const bad = join(f.dir, "invalid-encoder");
      await writeFile(bad, '#!/bin/sh\ncat >/dev/null\nprintf "not an MP3"\n', {
        mode: 0o700,
      });
      await assert.rejects(
        processPrivateMedia(f.db, { ...f.config, ffmpegPath: bad }, f.p.id),
      );
      assert.notEqual((await f.ps.get(f.p.id)).status, "ready");
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 1);
      await f.c
        .write("put", `/creator/stories/${f.s.id}/chapters/${f.ch.id}`, {
          title: "New title",
          summary: "",
          expectedRevision: 1,
        })
        .expect(200);
      await f.db
        .prepare(
          "UPDATE private_processing_intents SET next_attempt_at=? WHERE id=?",
        )
        .run("2000-01-01T00:00:00.000Z", f.p.id);
      await processPrivateMedia(f.db, f.config, f.p.id);
      let p = await f.ps.get(f.p.id);
      assert.equal(p.error_code, "CHAPTER_CHANGED");
      assert.equal(p.status, "failed");
      await f.c
        .write("post", `${f.path}/${f.a.id}/processing/retry`, {
          expectedRevision: p.revision,
        })
        .expect(200);
      await processPrivateMedia(f.db, f.config, p.id);
      assert.equal((await f.ps.get(p.id)).status, "ready");
    } finally {
      await f.close();
    }
  });
