import { createHash, randomUUID } from "node:crypto";
import {
  curatedBooks,
  archiveAudioUrl,
  librivoxPage,
  plainText,
  sourceJson,
  sourceError,
} from "./source.js";

export function normalizeBook(selection, book, archive) {
  if (
    Number(book?.id) !== selection.id ||
    book.language !== "English" ||
    !Array.isArray(book.sections) ||
    !book.sections.length ||
    book.sections.length > 500 ||
    Number(book.num_sections) !== book.sections.length
  )
    throw sourceError("Incomplete or unexpected audiobook");
  const collections = [archive.metadata?.collection].flat();
  if (
    archive.metadata?.identifier !== selection.archive ||
    !collections.includes("librivoxaudio")
  )
    throw sourceError("Archive provenance mismatch");
  const storyId = 1000 + selection.id;
  const numbers = new Set(),
    ids = new Set();
  const chapters = book.sections
    .map((section) => {
      const externalId = Number(section.id),
        number = Number(section.section_number),
        duration = Number(section.playtime);
      if (
        !Number.isSafeInteger(externalId) ||
        externalId < 1 ||
        externalId >= 800000000 ||
        !Number.isInteger(number) ||
        number < 0 ||
        number > 500 ||
        numbers.has(number) ||
        ids.has(externalId) ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 21600
      )
        throw sourceError("Invalid chapter metadata");
      numbers.add(number);
      ids.add(externalId);
      const audio = archiveAudioUrl(section.listen_url, selection.archive);
      const file = archive.files?.find((f) => f.name === audio.file),
        size = Number(file?.size);
      if (
        !Number.isSafeInteger(size) ||
        size < 100 ||
        size > 100 * 1024 * 1024 ||
        !/^([a-f0-9]{32})$/i.test(file?.md5 || "")
      )
        throw sourceError("Missing or oversized chapter file");
      return {
        id: 100000000 + externalId,
        externalId,
        number,
        title: plainText(section.title, 250) || `Chapter ${number}`,
        duration,
        url: audio.url,
        size,
        md5: file.md5.toLowerCase(),
      };
    })
    .sort((a, b) => a.number - b.number);
  const firstNumber = chapters[0].number;
  if (
    ![0, 1].includes(firstNumber) ||
    chapters.some((c, i) => c.number !== i + firstNumber)
  )
    throw sourceError("Incomplete chapter order");
  // Some recordings number an introduction as section zero. Keep provider IDs
  // stable while exposing a contiguous, one-based chapter order in SoundWave.
  chapters.forEach((c, i) => {
    c.number = i + 1;
  });
  const narrator =
    [
      ...new Set(
        book.sections.flatMap((s) =>
          (s.readers || []).map((r) => plainText(r.display_name, 100)),
        ),
      ),
    ]
      .filter(Boolean)
      .join(", ")
      .slice(0, 1200) || "LibriVox volunteers";
  const result = {
    storyId,
    externalId: selection.id,
    title: plainText(book.title, 250),
    description: plainText(book.description),
    author: (book.authors || [])
      .map((a) => plainText(`${a.first_name || ""} ${a.last_name || ""}`, 150))
      .join(", ")
      .slice(0, 300),
    sourceUrl: librivoxPage(book.url_librivox),
    archive: selection.archive,
    narrator,
    genre: selection.genre,
    color: selection.color,
    symbol: selection.symbol,
    chapters,
  };
  if (!result.title || !result.author)
    throw sourceError("Missing book attribution");
  return {
    ...result,
    hash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  };
}
export async function importLibrivoxBook(
  db,
  projectId,
  { fetchImpl = fetch } = {},
) {
  const selection = curatedBooks.find((b) => b.id === projectId);
  if (!selection) throw sourceError("Book is not in the curated catalog");
  const feed = await sourceJson(
    `https://librivox.org/api/feed/audiobooks/?id=${selection.id}&extended=1&format=json`,
    { fetchImpl },
  );
  const archive = await sourceJson(
    `https://archive.org/metadata/${selection.archive}`,
    { fetchImpl },
  );
  const book = normalizeBook(selection, feed.books?.[0], archive);
  let changed = false;
  await db.transaction(async () => {
    if (db.dialect === "postgres")
      await db
        .prepare("SELECT pg_advisory_xact_lock(?)")
        .get(820000000 + projectId);
    const previous = await db
      .prepare(
        "SELECT story_id,content_hash FROM story_sources WHERE external_id=?",
      )
      .get(projectId);
    const occupiedStory = await db
      .prepare("SELECT id FROM stories WHERE id=?")
      .get(book.storyId);
    if (
      (occupiedStory && !previous) ||
      (previous && previous.story_id !== book.storyId)
    )
      throw sourceError("Catalog ID collision; existing story retained");
    const now = new Date().toISOString();
    if (previous?.content_hash === book.hash) {
      await db
        .prepare("UPDATE story_sources SET refreshed_at=? WHERE external_id=?")
        .run(now, projectId);
      return;
    }
    changed = true;
    const oldChapters = await db
      .prepare(
        "SELECT c.id,c.chapter_number,s.external_id FROM chapters c JOIN chapter_sources s ON s.chapter_id=c.id WHERE c.story_id=?",
      )
      .all(book.storyId);
    if (
      oldChapters.some(
        (c) =>
          !book.chapters.some(
            (n) => n.id === c.id && n.number === c.chapter_number,
          ),
      )
    )
      throw sourceError(
        "Published chapter order changed; operator review required",
      );
    await db
      .prepare(
        `INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,genre=excluded.genre,author=excluded.author,tagline=excluded.tagline,description=excluded.description,color=excluded.color,symbol=excluded.symbol`,
      )
      .run(
        book.storyId,
        book.title,
        book.genre,
        book.author,
        "Human-narrated audiobook · LibriVox",
        book.description,
        book.color,
        book.symbol,
        70,
      );
    for (const c of book.chapters) {
      const occupied = await db
        .prepare(
          "SELECT c.story_id,s.external_id FROM chapters c LEFT JOIN chapter_sources s ON s.chapter_id=c.id WHERE c.id=?",
        )
        .get(c.id);
      if (
        occupied &&
        (occupied.story_id !== book.storyId ||
          occupied.external_id !== c.externalId)
      )
        throw sourceError(
          "Catalog chapter ID collision; existing chapter retained",
        );
      await db
        .prepare(
          `INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,audio_url=excluded.audio_url,duration_seconds=excluded.duration_seconds`,
        )
        .run(
          c.id,
          book.storyId,
          c.number,
          c.title,
          `/external/librivox/${selection.id}/${c.externalId}`,
          c.duration,
        );
      await db
        .prepare(
          `INSERT INTO chapter_sources(chapter_id,external_id,audio_url,byte_length,content_type,file_md5) VALUES(?,?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET audio_url=excluded.audio_url,byte_length=excluded.byte_length,file_md5=excluded.file_md5`,
        )
        .run(c.id, c.externalId, c.url, c.size, "audio/mpeg", c.md5);
    }
    await db
      .prepare(
        `INSERT INTO story_sources(story_id,provider,external_id,source_url,archive_identifier,narrator,content_hash,refreshed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(story_id) DO UPDATE SET source_url=excluded.source_url,narrator=excluded.narrator,content_hash=excluded.content_hash,refreshed_at=excluded.refreshed_at`,
      )
      .run(
        book.storyId,
        "librivox",
        projectId,
        book.sourceUrl,
        book.archive,
        book.narrator,
        book.hash,
        now,
      );
    await db
      .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
      .run(randomUUID());
  });
  return { storyId: book.storyId, chapters: book.chapters.length, changed };
}
export async function enqueueLibrivoxImports(
  db,
  queue,
  { force = false, now = new Date() } = {},
) {
  let enqueued = 0;
  for (const [index, book] of curatedBooks.entries()) {
    const row = await db
      .prepare("SELECT refreshed_at FROM story_sources WHERE external_id=?")
      .get(book.id);
    if (!force && row && now - new Date(row.refreshed_at) < 7 * 86400000)
      continue;
    await queue.add(
      "import-librivox",
      { projectId: book.id },
      {
        jobId: `librivox-${book.id}-${force ? randomUUID() : now.toISOString().slice(0, 10)}`,
        delay: index * 2500,
        attempts: 4,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
    enqueued++;
  }
  return { enqueued };
}
