import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { catalog } from "../content/catalog.js";
export async function seedCatalog(db) {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../public/audio/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  await db.transaction(async () => {
    await db
      .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
      .run(randomUUID());
    for (const { chapters, ...story } of catalog) {
      const inserted = await db
        .prepare(
          `INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity)
        VALUES(@id,@title,@genre,@author,@tagline,@description,@color,@symbol,@popularity)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,genre=excluded.genre,author=excluded.author,
        tagline=excluded.tagline,description=excluded.description,color=excluded.color,symbol=excluded.symbol,popularity=excluded.popularity WHERE stories.ownership_kind='system' AND stories.owner_id IS NULL AND NOT EXISTS(SELECT 1 FROM story_sources x WHERE x.story_id=stories.id)`,
        )
        .run(story);
      if (!inserted.changes) continue;
      for (const [index, chapter] of chapters.entries()) {
        const audio = manifest[`${story.id}-${index + 1}`];
        await db
          .prepare(
            `INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,audio_url=excluded.audio_url,duration_seconds=excluded.duration_seconds WHERE chapters.story_id=excluded.story_id AND NOT EXISTS(SELECT 1 FROM chapter_sources x WHERE x.chapter_id=chapters.id)`,
          )
          .run(
            story.id * 100 + index + 1,
            story.id,
            index + 1,
            chapter.title,
            audio.audioUrl,
            audio.durationSeconds,
          );
      }
    }
  });
}
