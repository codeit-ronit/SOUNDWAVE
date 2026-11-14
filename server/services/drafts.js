import { assertPublicationEditable } from "./publication-visibility.js";
import { createHash } from "node:crypto";
import { authorizationService } from "./authorization.js";
import {
  draftRepository,
  storyDraft,
  chapterDraft,
} from "../repositories/drafts.js";
import { draftError } from "./draft-contract.js";
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function draftService(db) {
  const repo = draftRepository(db),
    auth = authorizationService(db);
  const active = async (principal) => {
    await auth.registered(principal, true);
    return auth.creator(principal);
  };
  const detail = async (id) => {
    const rows = await repo.chapters(id);
    if (rows.length > 100)
      throw draftError(
        409,
        "DRAFT_LIMIT",
        "Imported draft exceeds the active chapter limit.",
      );
    return {
      story: storyDraft(await repo.story(id)),
      chapters: rows.map(chapterDraft),
    };
  };
  const owned = async (principal, id) => {
    await auth.ownedStory(principal, id);
    return repo.story(id);
  };
  const fail = async (code, message, id, chapter) => {
    throw draftError(
      409,
      code,
      message,
      await detail(id),
      chapter && chapterDraft(chapter),
    );
  };
  const matches = async (row, expected, id, chapter) => {
    if ((chapter || row).draft_revision !== expected)
      await fail(
        "DRAFT_CONFLICT",
        "This draft changed. Reload before deciding how to apply your edits.",
        id,
        chapter,
      );
  };
  const editable = async (row) => {
    await assertPublicationEditable(db, row.id);
    if (row.draft_state !== "draft")
      await fail(
        "DRAFT_ARCHIVED",
        "This story is archived and cannot be edited.",
        row.id,
      );
  };
  const capacity = (condition, message) => {
    if (condition) throw draftError(409, "DRAFT_LIMIT", message);
  };
  const bump = async (id) => {
    const row = await repo.story(id);
    capacity(
      row.draft_revision >= Number.MAX_SAFE_INTEGER,
      "Story revision exhausted.",
    );
    await db
      .prepare("UPDATE stories SET draft_revision=draft_revision+1 WHERE id=?")
      .run(id);
  };
  const checkChapterRevision = (row) =>
    capacity(
      row.draft_revision >= Number.MAX_SAFE_INTEGER,
      "Chapter revision exhausted.",
    );
  const child = async (story, id) => {
    const row = await repo.chapter(story, id);
    if (!row) throw draftError(404, "CHAPTER_NOT_FOUND", "Chapter not found.");
    return row;
  };
  async function receipt(principal, key, hash) {
    const r = await repo.receipt(principal.id, key);
    if (!r) return null;
    if (r.request_hash !== hash)
      throw draftError(
        409,
        "DRAFT_REQUEST_REUSED",
        "This creation request ID was used for another payload.",
      );
    await owned(principal, r.story_id);
    return {
      ...(await detail(r.story_id)),
      ...(r.chapter_id
        ? { chapter: chapterDraft(await child(r.story_id, r.chapter_id)) }
        : {}),
      replayed: true,
    };
  }
  async function order(id, ids) {
    const rows = await repo.chapters(id),
      map = new Map(rows.map((row) => [row.id, row]));
    const changed = ids.some(
      (value, i) => map.get(value).chapter_number !== i + 1,
    );
    if (!changed) return false;
    const max =
      (
        await db
          .prepare(
            "SELECT MAX(chapter_number) AS n FROM chapters WHERE story_id=?",
          )
          .get(id)
      ).n || 0;
    capacity(
      max + ids.length > 2147483647,
      "Chapter ordering space exhausted.",
    );
    for (const row of rows)
      if (row.chapter_number !== ids.indexOf(row.id) + 1)
        checkChapterRevision(row);
    for (const [i, value] of ids.entries())
      await db
        .prepare(
          "UPDATE chapters SET chapter_number=? WHERE story_id=? AND id=?",
        )
        .run(max + i + 1, id, value);
    for (const [i, value] of ids.entries())
      await db
        .prepare(
          "UPDATE chapters SET chapter_number=?,draft_revision=draft_revision+? WHERE story_id=? AND id=?",
        )
        .run(i + 1, Number(map.get(value).chapter_number !== i + 1), id, value);
    return true;
  }
  return {
    list: (principal, limit, before) =>
      db.transaction(async () => {
        await active(principal);
        const rows = await repo.list(principal.id, limit, before),
          page = rows.slice(0, limit);
        return {
          stories: page.map(storyDraft),
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    owner: principal.id,
                    before: page.at(-1).id,
                  }),
                ).toString("base64url")
              : null,
        };
      }),
    read: (principal, id) =>
      db.transaction(async () => {
        await owned(principal, id);
        return detail(id);
      }),
    readChapter: (principal, id, chapter) =>
      db.transaction(async () => {
        await owned(principal, id);
        return {
          storyRevision: (await repo.story(id)).draft_revision,
          chapter: chapterDraft(await child(id, chapter)),
        };
      }),
    create: (principal, metadata, key) =>
      db.transaction(async () => {
        const profile = await active(principal),
          hash = fingerprint({ kind: "story", ...metadata }),
          retry = await receipt(principal, key, hash);
        if (retry) return retry;
        capacity(
          (await repo.countStories(principal.id)).n >= 100,
          "At most 100 retained stories per account.",
        );
        const id = await repo.allocate("story");
        capacity(!id, "Creator story IDs exhausted.");
        await db
          .prepare(
            "INSERT INTO stories(id,title,description,genre,language,author,tagline,color,symbol,popularity,ownership_kind,owner_id) VALUES(?,?,?,?,?,?,'','#8267db','radio',0,'creator',?)",
          )
          .run(
            id,
            metadata.title,
            metadata.description,
            metadata.genre,
            metadata.language,
            profile.display_name,
            principal.id,
          );
        await repo.saveReceipt(principal.id, key, hash, "story", id);
        return { ...(await detail(id)), replayed: false };
      }),
    edit: (principal, id, metadata, expected) =>
      db.transaction(async () => {
        const row = await owned(principal, id);
        await matches(row, expected, id);
        await editable(row);
        await bump(id);
        await db
          .prepare(
            "UPDATE stories SET title=?,description=?,genre=?,language=? WHERE id=?",
          )
          .run(
            metadata.title,
            metadata.description,
            metadata.genre,
            metadata.language,
            id,
          );
        return detail(id);
      }),
    archive: (principal, id, expected) =>
      db.transaction(async () => {
        const row = await owned(principal, id);
        await matches(row, expected, id);
        await assertPublicationEditable(db, id);
        if (row.draft_state !== "archived") {
          await bump(id);
          await db
            .prepare("UPDATE stories SET draft_state='archived' WHERE id=?")
            .run(id);
        }
        return detail(id);
      }),
    addChapter: (principal, id, metadata, key, expected) =>
      db.transaction(async () => {
        const row = await owned(principal, id),
          hash = fingerprint({
            kind: "chapter",
            story: id,
            expectedStoryRevision: expected,
            ...metadata,
          }),
          retry = await receipt(principal, key, hash);
        if (retry) return retry;
        await matches(row, expected, id);
        await editable(row);
        const rows = await repo.chapters(id);
        capacity(
          rows.length >= 100 || (await repo.countChapters(id)).n >= 500,
          "Limit: 100 active and 500 retained chapters per story.",
        );
        const chapterId = await repo.allocate("chapter");
        capacity(!chapterId, "Creator chapter IDs exhausted.");
        await order(
          id,
          rows.map((c) => c.id),
        );
        await db
          .prepare(
            "INSERT INTO chapters(id,story_id,chapter_number,title,summary,audio_url,duration_seconds) VALUES(?,?,?,?,?,'',1)",
          )
          .run(
            chapterId,
            id,
            rows.length + 1,
            metadata.title,
            metadata.summary,
          );
        await bump(id);
        await repo.saveReceipt(
          principal.id,
          key,
          hash,
          "chapter",
          id,
          chapterId,
        );
        return {
          ...(await detail(id)),
          chapter: chapterDraft(await child(id, chapterId)),
          replayed: false,
        };
      }),
    editChapter: (principal, id, chapterId, metadata, expected) =>
      db.transaction(async () => {
        const row = await owned(principal, id),
          chapter = await child(id, chapterId);
        await matches(row, expected, id, chapter);
        await editable(row);
        if (chapter.draft_removed)
          await fail(
            "CHAPTER_REMOVED",
            "This chapter was removed.",
            id,
            chapter,
          );
        checkChapterRevision(chapter);
        await db
          .prepare(
            "UPDATE chapters SET title=?,summary=?,draft_revision=draft_revision+1 WHERE story_id=? AND id=?",
          )
          .run(metadata.title, metadata.summary, id, chapterId);
        return detail(id);
      }),
    removeChapter: (principal, id, chapterId, expected, expectedStory) =>
      db.transaction(async () => {
        const row = await owned(principal, id),
          chapter = await child(id, chapterId);
        await matches(row, expectedStory, id);
        await matches(row, expected, id, chapter);
        await editable(row);
        if (chapter.draft_removed)
          return { ...(await detail(id)), chapter: chapterDraft(chapter) };
        checkChapterRevision(chapter);
        const max =
            (
              await db
                .prepare(
                  "SELECT MAX(chapter_number) AS n FROM chapters WHERE story_id=?",
                )
                .get(id)
            ).n || 0,
          retired = Math.max(1000, max + 1);
        capacity(retired > 2147483500, "Chapter ordering space exhausted.");
        await db
          .prepare(
            "UPDATE chapters SET draft_removed=1,chapter_number=?,draft_revision=draft_revision+1 WHERE story_id=? AND id=?",
          )
          .run(retired, id, chapterId);
        await order(
          id,
          (await repo.chapters(id)).map((c) => c.id),
        );
        await bump(id);
        return {
          ...(await detail(id)),
          chapter: chapterDraft(await child(id, chapterId)),
        };
      }),
    reorder: (principal, id, ids, expected) =>
      db.transaction(async () => {
        const row = await owned(principal, id);
        await matches(row, expected, id);
        await editable(row);
        const rows = await repo.chapters(id);
        if (
          rows.length !== ids.length ||
          new Set(ids).size !== ids.length ||
          ids.some((value) => !rows.some((c) => c.id === value))
        )
          throw draftError(
            400,
            "INVALID_DRAFT_ORDER",
            "Supply every active chapter exactly once.",
          );
        if (await order(id, ids)) await bump(id);
        return detail(id);
      }),
  };
}
