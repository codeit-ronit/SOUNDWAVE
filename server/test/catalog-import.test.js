import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { backends, fixture } from "./phase2-helpers.js";
import {
  importLibrivoxBook,
  enqueueLibrivoxImports,
  normalizeBook,
} from "../catalog/import.js";
import {
  archiveAudioUrl,
  librivoxPage,
  sourceJson,
  curatedBooks,
} from "../catalog/source.js";
import {
  mediaQueue,
  startMediaWorker,
  enqueueCatalogMedia,
} from "../media/queue.js";
import { redisInfrastructure } from "../infrastructure/redis.js";
function upstream() {
  const book = {
    id: "200",
    title: "Alice test audiobook",
    language: "English",
    num_sections: "2",
    url_librivox: "https://librivox.org/alice-test/",
    description:
      "<p>A real <b>test</b> &amp; source.</p><script>bad()</script>",
    authors: [{ first_name: "Lewis", last_name: "Carroll" }],
    sections: [1, 2].map((n) => ({
      id: String(900000 + n),
      section_number: String(n),
      title: `Part ${n}`,
      playtime: "600",
      listen_url: `https://www.archive.org/download/alice_in_wonderland_librivox/part_${n}.mp3`,
      readers: [{ display_name: "Test narrator" }],
    })),
  };
  const archive = {
    metadata: {
      identifier: "alice_in_wonderland_librivox",
      collection: ["librivoxaudio"],
    },
    files: [1, 2].map((n) => ({
      name: `part_${n}.mp3`,
      size: "1024",
      md5: "a".repeat(32),
    })),
  };
  let calls = 0,
    fail = false;
  return {
    book,
    archive,
    get calls() {
      return calls;
    },
    set fail(v) {
      fail = v;
    },
    fetch: async (url) => {
      calls++;
      if (fail) return new Response("unavailable", { status: 503 });
      return Response.json(
        url.startsWith("https://librivox.org/") ? { books: [book] } : archive,
      );
    },
  };
}
test("external catalog permits only approved HTTPS archive MP3 paths and attribution links", () => {
  for (const url of [
    "http://archive.org/download/a/a.mp3",
    "https://archive.org.evil.test/download/a/a.mp3",
    "https://user@archive.org/download/a/a.mp3",
    "https://127.0.0.1/download/a/a.mp3",
    "https://archive.org/download/other/a.mp3",
    "https://archive.org/download/a/%2fetc.mp3",
    "https://archive.org/download/a/../a.mp3",
    "https://archive.org/download/a/a.mp3?url=evil",
  ])
    assert.throws(() => archiveAudioUrl(url, "a"));
  assert.equal(
    archiveAudioUrl("https://www.archive.org/download/a/a.mp3", "a").url,
    "https://archive.org/download/a/a.mp3",
  );
  assert.throws(() => librivoxPage("https://evil.test/book/"));
});
test("external responses are bounded and HTTP failures are retryable", async () => {
  await assert.rejects(
    sourceJson("https://librivox.org/", {
      fetchImpl: async () => new Response("x".repeat(200)),
      limit: 100,
    }),
    /Oversized/,
  );
  await assert.rejects(
    sourceJson("https://librivox.org/", {
      fetchImpl: async () => new Response("x", { status: 429 }),
    }),
    (e) => e.code === "UPSTREAM_UNAVAILABLE",
  );
});
test("provider section zero becomes chapter one without changing stable chapter IDs", () => {
  const u = upstream(),
    selection = curatedBooks.find((b) => b.id === 200);
  u.book.sections.forEach((s, i) => {
    s.section_number = String(i);
  });
  const book = normalizeBook(selection, u.book, u.archive);
  assert.deepEqual(
    book.chapters.map((c) => c.number),
    [1, 2],
  );
  assert.deepEqual(
    book.chapters.map((c) => c.id),
    [100900001, 100900002],
  );
  u.book.sections[1].section_number = "2";
  assert.throws(
    () => normalizeBook(selection, u.book, u.archive),
    /Incomplete chapter order/,
  );
});
for (const backend of backends) {
  test(`${backend}: transactional source import preserves ownership, stable chapters, progress and byte-range delivery`, async () => {
    const f = await fixture(backend),
      u = upstream();
    try {
      const imported = await importLibrivoxBook(f.db, 200, {
        fetchImpl: u.fetch,
      });
      assert.deepEqual(imported, { storyId: 1200, chapters: 2, changed: true });
      const a = await f.client(),
        b = await f.client();
      await a.auth("demo");
      await b.auth("demo");
      const story = (await a.get("/stories/1200").expect(200)).body.story;
      assert.equal(story.content_source, "librivox");
      assert.equal(story.description, "A real test & source.");
      assert.equal(story.narrator, "Test narrator");
      assert.equal((await a.get("/stories?q=Alice").expect(200)).body.total, 1);
      await a.write("put", "/library/1200", {}).expect(200);
      await a
        .write("put", "/progress/100900001", { positionSeconds: 42 })
        .expect(200);
      assert.equal(
        (await b.get("/library").expect(200)).body.stories.length,
        0,
      );
      assert.equal(
        (await b.get("/progress").expect(200)).body.progress.length,
        0,
      );
      const revision = (
        await f.db
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
      const again = await Promise.all([
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
      ]);
      assert.ok(again.every((r) => !r.changed));
      assert.equal(
        (
          await f.db
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        revision,
      );
      assert.equal(
        (await a.get("/progress").expect(200)).body.progress[0]
          .position_seconds,
        42,
      );
      assert.equal(
        (await a.get("/library").expect(200)).body.stories[0].id,
        1200,
      );
      const stream = await a
        .get("/chapters/100900001/stream")
        .set("Range", "bytes=0-99")
        .expect(307);
      assert.equal(
        stream.headers.location,
        "https://archive.org/download/alice_in_wonderland_librivox/part_1.mp3",
      );
      await a
        .get("/chapters/100900001/stream")
        .set("Range", "bytes=9999-")
        .expect(416);
      await a
        .get("/chapters/100900001/stream")
        .set("Range", "bytes=0-1,2-3")
        .expect(416);
      const head = await a.agent
        .head("/api/chapters/100900001/stream")
        .set("Range", "bytes=0-1")
        .expect(200);
      assert.equal(head.headers["content-length"], "1024");
      assert.equal(head.headers["content-type"], "audio/mpeg");
      const metadata = (await a.get("/chapters/100900001/metadata").expect(200))
        .body;
      assert.equal(metadata.status, "source-metadata");
      assert.equal(metadata.metadata.waveform, null);
      const jobs = [];
      await enqueueCatalogMedia(f.db, {
        add: async (...args) => jobs.push(args),
      });
      assert.equal(jobs.length, 12);
      assert.ok(jobs.every((j) => j[1].chapterId < 100000000));
      u.book.title = "Updated Alice";
      await importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch });
      assert.notEqual(
        (
          await f.db
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        revision,
      );
      u.fail = true;
      await assert.rejects(
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
      );
      assert.equal(
        (await a.get("/stories/1200").expect(200)).body.story.title,
        "Updated Alice",
      );
      await assert.rejects(
        importLibrivoxBook(f.db, 999999, { fetchImpl: u.fetch }),
        /curated/,
      );
    } finally {
      await f.close();
    }
  });
  test(`${backend}: invalid chapter batches never publish partial books`, async () => {
    const f = await fixture(backend),
      u = upstream();
    try {
      u.archive.files[1].size = "invalid";
      await assert.rejects(
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM stories").get()).n,
        6,
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM story_sources").get()).n,
        0,
      );
    } finally {
      await f.close();
    }
  });
  test(`${backend}: import collisions preserve existing catalog rows`, async () => {
    const f = await fixture(backend),
      u = upstream();
    try {
      await f.db
        .prepare(
          "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1200,
          "Existing catalog entry",
          "Mystery",
          "Existing author",
          "Keep me",
          "Keep me",
          "#123456",
          "radio",
          1,
        );
      await assert.rejects(
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
        /collision/,
      );
      assert.equal(
        (await f.db.prepare("SELECT title FROM stories WHERE id=1200").get())
          .title,
        "Existing catalog entry",
      );
      await f.db.prepare("DELETE FROM stories WHERE id=?").run(1200);
      await f.db
        .prepare(
          "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,?,?,?,?,?)",
        )
        .run(100900001, 1, 3, "Existing chapter", "/audio/1-1.wav", 30);
      await assert.rejects(
        importLibrivoxBook(f.db, 200, { fetchImpl: u.fetch }),
        /chapter ID collision/,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM stories WHERE id=1200")
            .get()
        ).n,
        0,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT title FROM chapters WHERE id=100900001")
            .get()
        ).title,
        "Existing chapter",
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM chapter_sources").get())
          .n,
        0,
      );
    } finally {
      await f.close();
    }
  });
}
if (process.env.TEST_REDIS_URL) {
  test("real Redis import invalidates cached discovery and BullMQ retries an actual failed import", async () => {
    const prefix = "catalog-test-" + randomUUID(),
      redis = redisInfrastructure(process.env.TEST_REDIS_URL, { prefix }),
      f = await fixture(process.env.TEST_DATABASE_URL ? "postgres" : "sqlite", {
        redis,
        config: { catalogCacheEnabled: true },
      }),
      u = upstream(),
      config = { redisUrl: process.env.TEST_REDIS_URL, redisPrefix: prefix },
      queue = mediaQueue(config);
    let worker;
    try {
      await redis.client.connect();
      const a = await f.client();
      await a.get("/stories").expect(200);
      await a.get("/stories").expect(200);
      assert.ok(redis.cacheStats().hits > 0);
      let attempt = 0;
      const sourceFetch = async (url) => {
        if (attempt++ === 0) return new Response("temporary", { status: 503 });
        return u.fetch(url);
      };
      worker = startMediaWorker(f.db, config, { sourceFetch });
      await worker.waitUntilReady();
      const job = await queue.add(
        "import-librivox",
        { projectId: 200 },
        {
          jobId: "librivox-test",
          attempts: 2,
          backoff: { type: "exponential", delay: 50 },
        },
      );
      for (let n = 0; n < 150 && (await job.getState()) !== "completed"; n++)
        await delay(50);
      assert.equal(await job.getState(), "completed");
      assert.equal((await queue.getJob(job.id)).attemptsMade, 2);
      assert.equal((await a.get("/stories").expect(200)).body.total, 7);
      const jobs = [];
      await enqueueLibrivoxImports(f.db, {
        add: async (...args) => jobs.push(args),
      });
      assert.equal(jobs.length, curatedBooks.length - 1);
      assert.ok(!jobs.some((j) => j[1].projectId === 200));
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.close();
      await f.close();
    }
  });
}
