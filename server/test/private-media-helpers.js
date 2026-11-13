import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fixture, password } from "./phase2-helpers.js";
import { privateMediaService } from "../services/private-media.js";
import { wav } from "./private-wav-fixture.js";
export async function setup(kind, config = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "soundwave-upload-"));
  const f = await fixture(kind, {
      ...options,
      config: {
        privateMediaRoot: join(dir, "media"),
        uploadSeconds: 1,
        ...config,
      },
    }),
    c = await f.client();
  const registered = await c.auth("register", {
    email: `${randomUUID()}@example.com`,
    password,
    displayName: "Upload creator",
  });
  assert.equal(registered.status, 200);
  c.cookie = registered.headers["set-cookie"]
    .map((x) => x.split(";")[0])
    .join("; ");
  await c
    .write("post", "/creator", { displayName: "Upload creator", bio: "" })
    .expect(200);
  const s = (
    await c
      .write("post", "/creator/stories", {
        title: "Private media",
        description: "",
        genre: "Test",
        language: "en",
        requestId: randomUUID(),
      })
      .expect(201)
  ).body.story;
  const a = (
    await c
      .write("post", `/creator/stories/${s.id}/chapters`, {
        title: "Chapter",
        summary: "",
        expectedStoryRevision: s.revision,
        requestId: randomUUID(),
      })
      .expect(201)
  ).body;
  const path = `/creator/stories/${s.id}/chapters/${a.chapter.id}/media`,
    service = privateMediaService(f.db, f.config);
  return {
    ...f,
    c,
    s: a.story,
    ch: a.chapter,
    path,
    service,
    dir,
    close: async () => {
      await f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function reserve(f, b = wav(), extra = {}) {
  return f.c.write("post", f.path, {
    requestId: randomUUID(),
    byteSize: b.length,
    expectedChapterRevision: f.ch.revision,
    expectedHeadRevision: (await f.c.get(f.path).expect(200)).body.headRevision,
    ...extra,
  });
}
