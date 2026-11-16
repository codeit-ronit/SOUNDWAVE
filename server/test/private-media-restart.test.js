import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { wav } from "./private-wav-fixture.js";
test("private upload bytes, current pointer and single-use identity survive a real API process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soundwave-upload-restart-")),
    listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const base = `http://127.0.0.1:${port}`;
  let child,
    cookie = "",
    csrf = "";
  async function start() {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../index.js", import.meta.url))],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          DATABASE_DRIVER: "sqlite",
          DATABASE_PATH: join(dir, "db.sqlite"),
          PRIVATE_MEDIA_ROOT: join(dir, "objects"),
          PORT: String(port),
          APP_ORIGIN: base,
          NODE_ENV: "development",
          REDIS_URL: "",
          SMTP_URL: "",
          EMAIL_MODE: "disabled",
          GOOGLE_CLIENT_ID: "",
          MEDIA_JOBS: "false",
          LIBRIVOX_CATALOG: "false",
          HTTP_LOG: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("API startup timed out")),
        12000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("API exited during startup"));
      });
      child.stdout.on("data", (b) => {
        if (b.toString().includes("SoundWave API")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", () => {});
    });
  }
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null;
      return;
    }
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
    child = null;
  }
  async function api(path, method = "GET", body, type = "application/json") {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { Cookie: cookie, "Content-Type": type, "X-CSRF-Token": csrf },
      ...(body
        ? { body: type === "application/json" ? JSON.stringify(body) : body }
        : {}),
    });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((x) => x.split(";")[0]).join("; ");
    const j = await r.json();
    if (j.csrfToken) csrf = j.csrfToken;
    assert.ok(r.status < 300, JSON.stringify(j));
    return j;
  }
  try {
    await start();
    await api("/auth/session");
    await api("/auth/register", "POST", {
      email: `${randomUUID()}@example.com`,
      password: "restart test password!",
      displayName: "Restart creator",
    });
    await api("/creator", "POST", { displayName: "Restart creator", bio: "" });
    const s = (
      await api("/creator/stories", "POST", {
        title: "Restart story",
        description: "",
        genre: "Test",
        language: "en",
        requestId: randomUUID(),
      })
    ).story;
    const c = (
      await api(`/creator/stories/${s.id}/chapters`, "POST", {
        title: "Chapter",
        summary: "",
        requestId: randomUUID(),
        expectedStoryRevision: s.revision,
      })
    ).chapter;
    const path = `/creator/stories/${s.id}/chapters/${c.id}/media`,
      body = {
        requestId: randomUUID(),
        byteSize: wav().length,
        expectedChapterRevision: 1,
        expectedHeadRevision: 0,
      };
    const a = (await api(path, "POST", body)).asset;
    await api(`${path}/${a.id}/bytes`, "PUT", wav(), "audio/wav");
    await stop();
    const verified = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/private-media.js", import.meta.url)),
        "verify",
        "--confirm-operator",
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "",
          DATABASE_DRIVER: "sqlite",
          DATABASE_PATH: join(dir, "db.sqlite"),
          PRIVATE_MEDIA_ROOT: join(dir, "objects"),
          EMAIL_MODE: "disabled",
          GOOGLE_CLIENT_ID: "",
        },
        encoding: "utf8",
        timeout: 12000,
      },
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), {
      action: "verify",
      checked: 1,
      unavailable: 0,
    });
    await start();
    const state = await api(path);
    assert.equal(state.current.id, a.id);
    assert.equal(state.current.status, "validated");
    assert.equal(state.usedBytes, wav().length);
    const r = await fetch(base + `/api${path}/${a.id}/preview`, {
      headers: { Cookie: cookie, Range: "bytes=0-43" },
    });
    assert.equal(r.status, 206);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), wav().subarray(0, 44));
    assert.equal((await api(path, "POST", body)).asset.id, a.id);
    assert.equal(
      (await api(`${path}/${a.id}/bytes`, "PUT", wav(), "audio/wav")).replayed,
      true,
    );
    assert.equal((await readdir(join(dir, "objects"))).length, 1);
  } finally {
    if (child) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
