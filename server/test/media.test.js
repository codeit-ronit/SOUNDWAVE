import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { backends, fixture } from "./phase2-helpers.js";
import {
  inspectWav,
  audioPath,
  sourceHash,
  processChapterMedia,
} from "../media/audio.js";
import { mediaQueue, startMediaWorker } from "../media/queue.js";
import { setTimeout as delay } from "node:timers/promises";
function pcm(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
}
test("WAV analysis measures actual samples and rejects malformed/unsupported input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soundwave-waveform-")),
    path = join(dir, "sample.wav");
  try {
    writeFileSync(path, pcm([0, 16384, -32768, 8192]));
    const result = await inspectWav(path, { bins: 4 });
    assert.deepEqual(result.waveform, [0, 0.5, 1, 0.25]);
    assert.equal(result.durationSeconds, 4 / 8000);
    assert.ok(Math.abs(result.rms - Math.sqrt(1.3125 / 4)) < 1e-9);
    writeFileSync(path, Buffer.from("bad"));
    await assert.rejects(inspectWav(path), /invalid_wav/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const backend of backends)
  test(`${backend}: real chapter processing persists metadata once and exposes it through the API`, async () => {
    const f = await fixture(backend);
    try {
      const a = await f.client();
      await a.get("/chapters/101/metadata").expect(202);
      const hash = await sourceHash(await audioPath(f.db, 101));
      await processChapterMedia(f.db, { chapterId: 101, hash });
      const first = (await a.get("/chapters/101/metadata").expect(200)).body
        .metadata;
      assert.equal(first.sample_rate, 22050);
      assert.equal(first.channels, 1);
      assert.equal(first.waveform.length, 128);
      assert.ok(first.waveform.some((v) => v > 0));
      const duration = (
        await f.db
          .prepare("SELECT duration_seconds FROM chapters WHERE id=?")
          .get(101)
      ).duration_seconds;
      assert.ok(Math.abs(first.duration_seconds - duration) < 0.001);
      assert.deepEqual(
        await processChapterMedia(f.db, { chapterId: 101, hash }),
        { chapterId: 101, unchanged: true },
      );
      assert.equal(
        (await a.get("/chapters/101/metadata")).body.metadata.processed_at,
        first.processed_at,
      );
      await assert.rejects(
        processChapterMedia(f.db, { chapterId: 101, hash: "0".repeat(64) }),
      );
      await f.db
        .prepare("UPDATE chapters SET audio_url=? WHERE id=?")
        .run("/audio/../../secret.wav", 101);
      await assert.rejects(audioPath(f.db, 101));
      await a.get("/chapters/bad/metadata").expect(400);
      await a.get("/chapters/99999/metadata").expect(404);
    } finally {
      await f.close();
    }
  });
if (process.env.TEST_REDIS_URL)
  test("BullMQ runs useful media work with exponential retries, idempotence and failed-job visibility", async () => {
    const f = await fixture("sqlite"),
      config = {
        redisUrl: process.env.TEST_REDIS_URL,
        redisPrefix: "media-test-" + randomUUID(),
      },
      queue = mediaQueue(config);
    let worker;
    try {
      await queue.waitUntilReady();
      const hash = await sourceHash(await audioPath(f.db, 101));
      let attempts = 0;
      const times = [];
      worker = startMediaWorker(f.db, config, {
        processor: async (job) => {
          times.push(Date.now());
          if (++attempts < 3) throw Error("transient_fixture");
          return processChapterMedia(f.db, job.data);
        },
        workerOptions: { concurrency: 1 },
      });
      const job = await queue.add(
        "analyze-wav",
        { chapterId: 101, hash },
        {
          jobId: "media-retry-test",
          attempts: 3,
          backoff: { type: "exponential", delay: 100 },
        },
      );
      const until = async (fn) => {
        for (let i = 0; i < 200; i++) {
          const result = await fn();
          if (result) return result;
          await delay(50);
        }
        throw Error("media job timeout");
      };
      await until(async () => (await job.getState()) === "completed");
      assert.equal(attempts, 3);
      assert.ok(times[1] - times[0] >= 90);
      assert.ok(times[2] - times[1] >= 190);
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM chapter_media").get()).n,
        1,
      );
      await worker.close();
      worker = startMediaWorker(f.db, config);
      const failed = await queue.add(
        "analyze-wav",
        { chapterId: 99999, hash },
        { jobId: "media-invalid-test" },
      );
      await until(async () => (await failed.getState()) === "failed");
      assert.ok((await queue.getJobCounts("failed")).failed >= 1);
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await f.close();
    }
  });
