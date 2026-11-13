import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as turn } from "node:timers/promises";
import { setup, reserve } from "./private-media-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { backends } from "./phase2-helpers.js";
import {
  privateProcessingQueue,
  startPrivateProcessingWorker,
  transportId,
} from "../media/private-queue.js";
import { processingIntents } from "../services/processing-intents.js";
import { runOnce } from "../jobs/worker.js";
import { processPrivateMedia } from "../media/private-processor.js";
async function until(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await turn();
  }
  throw Error("Timed out waiting for durable processing state");
}
async function upload(f, frames = 8000) {
  const b = wav(frames),
    a = (await reserve(f, b)).body.asset;
  await f.c
    .write("put", `${f.path}/${a.id}/bytes`, b)
    .set("Content-Type", "audio/wav")
    .expect(200);
  return f.db
    .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
    .get(a.id);
}
for (const kind of backends) {
  if (process.env.TEST_REDIS_URL)
    test(`${kind}: durable outbox dispatch and Redis-loss replay recover the same processing identity`, async () => {
      const f = await setup(kind, {
        redisUrl: process.env.TEST_REDIS_URL,
        redisPrefix: "ci-private-" + randomUUID(),
        processingSeconds: 5,
        derivativeMaxBytes: 262144,
      });
      let queue = privateProcessingQueue(f.config);
      let worker;
      try {
        const p = await upload(f),
          ps = processingIntents(f.db, f.config, f.service.storage);
        assert.equal(await runOnce(f.db, { privateQueue: queue }), true);
        assert.ok(await queue.getJob(transportId(p)));
        await queue.obliterate({ force: true });
        assert.equal(await queue.getJob(transportId(p)), undefined);
        await f.db
          .prepare("UPDATE background_jobs SET completed_at=? WHERE id=?")
          .run("2000-01-01T00:00:00.000Z", p.outbox_id);
        await ps.reconcile();
        assert.equal(
          (
            await f.db
              .prepare("SELECT status FROM background_jobs WHERE id=?")
              .get(p.outbox_id)
          ).status,
          "pending",
        );
        await runOnce(f.db, { privateQueue: queue });
        worker = startPrivateProcessingWorker(f.db, f.config);
        await until(async () => (await ps.get(p.id)).status === "ready");
        const first = (await f.c.get(f.path)).body.derivative;
        await queue.add(
          "private-audio",
          { intentId: p.id },
          { jobId: "duplicate-" + randomUUID() },
        );
        await until(async () => (await queue.getCompletedCount()) >= 2);
        assert.equal((await ps.get(p.id)).attempts, 1);
        assert.equal((await f.c.get(f.path)).body.derivative.id, first.id);
        // A real disconnected Redis client leaves the durable outbox/intent pending.
        const other = await upload(f, 4000);
        await queue.close();
        assert.equal(await runOnce(f.db, { privateQueue: queue }), true);
        const job = await f.db
          .prepare("SELECT * FROM background_jobs WHERE id=?")
          .get(other.outbox_id);
        assert.equal(job.status, "pending");
        assert.ok(job.last_error);
        queue = privateProcessingQueue(f.config);
        await f.db
          .prepare("UPDATE background_jobs SET available_at=? WHERE id=?")
          .run("2000-01-01T00:00:00.000Z", job.id);
        await runOnce(f.db, { privateQueue: queue });
        await until(async () => (await ps.get(other.id)).status === "ready");
      } finally {
        await worker?.close();
        try {
          await queue.obliterate({ force: true });
        } catch {}
        await queue.close().catch(() => {});
        await f.close();
      }
    });
  test(`${kind}: worker crash during transcoding, after output and after commit recovers without duplicate artifacts`, async () => {
    for (const phase of ["transcoding", "written", "committed"]) {
      const folder = await mkdtemp(join(tmpdir(), "processing-crash-")),
        sqlite = join(folder, "db.sqlite"),
        f = await setup(
          kind,
          { processingSeconds: 5, derivativeMaxBytes: 524288 },
          { sqlitePath: sqlite },
        );
      let child;
      try {
        const p = await upload(f, phase === "transcoding" ? 80000 : 8000),
          ps = processingIntents(f.db, f.config, f.service.storage);
        const schema =
          kind === "postgres"
            ? /search_path=([a-z0-9_]+)/.exec(f.db.pool.options.options)[1]
            : "";
        child = fork(
          fileURLToPath(new URL("./processing-child.mjs", import.meta.url)),
          [],
          {
            env: {
              ...process.env,
              PROCESSING_TEST_SQLITE: sqlite,
              PROCESSING_TEST_SCHEMA: schema,
              PROCESSING_TEST_INTENT: p.id,
              PROCESSING_TEST_PAUSE: phase,
              PRIVATE_MEDIA_ROOT: f.config.privateMediaRoot,
              PROCESSING_TIMEOUT_SECONDS: "5",
              DERIVATIVE_MAX_BYTES: "524288",
              EMAIL_MODE: "disabled",
              NODE_ENV: "development",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        child.stderr.on("data", () => {});
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Worker checkpoint timed out")),
            12000,
          );
          child.on("message", (m) => {
            if (m.phase === phase) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(Error("Worker exited before checkpoint"));
          });
        });
        if (phase === "transcoding")
          await until(async () => {
            const out = await f.db
              .prepare("SELECT * FROM private_media_outputs WHERE intent_id=?")
              .get(p.id);
            try {
              return (
                (
                  await stat(
                    join(f.config.privateMediaRoot, out.object_key + ".blob"),
                  )
                ).size > 0
              );
            } catch {
              return false;
            }
          });
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        child = null;
        if (phase !== "committed") {
          await f.db
            .prepare(
              "UPDATE private_processing_intents SET lease_until=? WHERE id=?",
            )
            .run("2000-01-01T00:00:00.000Z", p.id);
          await f.db
            .prepare(
              "UPDATE private_media_outputs SET lease_until=? WHERE intent_id=?",
            )
            .run("2000-01-01T00:00:00.000Z", p.id);
        }
        // Restart the same real handler in a new Node process, using persisted DB/files.
        child = fork(
          fileURLToPath(new URL("./processing-child.mjs", import.meta.url)),
          [],
          {
            env: {
              ...process.env,
              PROCESSING_TEST_SQLITE: sqlite,
              PROCESSING_TEST_SCHEMA: schema,
              PROCESSING_TEST_INTENT: p.id,
              PRIVATE_MEDIA_ROOT: f.config.privateMediaRoot,
              PROCESSING_TIMEOUT_SECONDS: "5",
              DERIVATIVE_MAX_BYTES: "524288",
              EMAIL_MODE: "disabled",
              NODE_ENV: "development",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        child.stderr.on("data", () => {});
        const [code] = await once(child, "exit");
        child = null;
        assert.equal(code, 0);
        await ps.sweep();
        const state = await ps.get(p.id);
        assert.equal(state.status, "ready");
        assert.equal(state.attempts, phase === "committed" ? 1 : 2);
        assert.equal((await readdir(f.config.privateMediaRoot)).length, 2);
        assert.equal(
          (
            await f.db
              .prepare(
                "SELECT COUNT(*) AS n FROM private_media_outputs WHERE intent_id=? AND status='ready'",
              )
              .get(p.id)
          ).n,
          1,
        );
        if (kind === "sqlite" && phase === "committed") {
          const verified = spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../scripts/private-media.js", import.meta.url),
              ),
              "verify",
              "--confirm-operator",
            ],
            {
              env: {
                ...process.env,
                DATABASE_URL: "",
                DATABASE_DRIVER: "sqlite",
                DATABASE_PATH: sqlite,
                PRIVATE_MEDIA_ROOT: f.config.privateMediaRoot,
                NODE_ENV: "development",
                EMAIL_MODE: "disabled",
              },
              encoding: "utf8",
              timeout: 12000,
            },
          );
          assert.equal(verified.status, 0, verified.stderr);
          assert.deepEqual(JSON.parse(verified.stdout), {
            action: "verify",
            checked: 2,
            unavailable: 0,
          });
        }
      } finally {
        if (child && child.exitCode === null) {
          const e = once(child, "exit");
          child.kill("SIGKILL");
          await e;
        }
        await f.close();
        await rm(folder, { recursive: true, force: true });
      }
    }
  });
}
