import { open, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
export const PROCESSOR_VERSION = 1;
const root = fileURLToPath(new URL("../public/audio/", import.meta.url));
const invalid = () =>
  Object.assign(Error("unsupported_or_invalid_wav"), { code: "INVALID_MEDIA" });
export async function audioPath(db, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw invalid();
  const row = await db
    .prepare("SELECT audio_url FROM chapters WHERE id=?")
    .get(id);
  if (!row || !/^\/audio\/[1-9]\d*-[1-9]\d*\.wav$/.test(row.audio_url))
    throw invalid();
  const [base, path] = await Promise.all([
    realpath(root),
    realpath(resolve(root, row.audio_url.slice(7))),
  ]);
  if (!path.startsWith(base + sep)) throw invalid();
  return path;
}
export async function sourceHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function inspectWav(path, { bins = 128 } = {}) {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1024) throw invalid();
  const f = await open(path, "r");
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > 100 * 1024 * 1024)
      throw invalid();
    const read = async (n, at) => {
      const b = Buffer.alloc(n);
      if ((await f.read(b, 0, n, at)).bytesRead !== n) throw invalid();
      return b;
    };
    const header = await read(12, 0);
    if (
      header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WAVE" ||
      header.readUInt32LE(4) + 8 !== stat.size
    )
      throw invalid();
    let format,
      data,
      at = 12;
    while (at + 8 <= stat.size) {
      const h = await read(8, at),
        length = h.readUInt32LE(4),
        type = h.toString("ascii", 0, 4);
      if (at + 8 + length > stat.size) throw invalid();
      if (type === "fmt ") {
        if (length < 16) throw invalid();
        const b = await read(16, at + 8);
        format = {
          codec: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          rate: b.readUInt32LE(4),
          align: b.readUInt16LE(12),
          bits: b.readUInt16LE(14),
        };
      }
      if (type === "data") data = { offset: at + 8, length };
      at += 8 + length + (length % 2);
    }
    if (
      !format ||
      !data ||
      format.codec !== 1 ||
      ![1, 2].includes(format.channels) ||
      format.bits !== 16 ||
      format.align !== format.channels * 2 ||
      format.rate < 8000 ||
      format.rate > 192000 ||
      !data.length ||
      data.length % format.align
    )
      throw invalid();
    const frames = data.length / format.align,
      peaks = Array(bins).fill(0);
    let squares = 0,
      frame = 0;
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < data.length;) {
      const size = Math.min(buffer.length, data.length - offset);
      const { bytesRead } = await f.read(buffer, 0, size, data.offset + offset);
      if (bytesRead !== size) throw invalid();
      for (let i = 0; i < size; i += format.align, frame++) {
        const bin = Math.min(bins - 1, Math.floor((frame * bins) / frames));
        for (let channel = 0; channel < format.channels; channel++) {
          const value = buffer.readInt16LE(i + channel * 2) / 32768;
          peaks[bin] = Math.max(peaks[bin], Math.abs(value));
          squares += value * value;
        }
      }
      offset += size;
    }
    return {
      codec: "pcm_s16le",
      sampleRate: format.rate,
      channels: format.channels,
      bitsPerSample: 16,
      durationSeconds: frames / format.rate,
      byteLength: stat.size,
      rms: Math.sqrt(squares / (frames * format.channels)),
      waveform: peaks.map((n) => Number(n.toFixed(5))),
    };
  } finally {
    await f.close();
  }
}
export async function processChapterMedia(db, { chapterId, hash }) {
  const path = await audioPath(db, chapterId),
    actual = await sourceHash(path);
  if (actual !== hash) throw invalid();
  const existing = await db
    .prepare(
      "SELECT source_hash,processor_version FROM chapter_media WHERE chapter_id=?",
    )
    .get(chapterId);
  if (
    existing?.source_hash === hash &&
    existing.processor_version === PROCESSOR_VERSION
  )
    return { chapterId, unchanged: true };
  const m = await inspectWav(path);
  if ((await sourceHash(path)) !== hash) throw invalid();
  await db.transaction(async () => {
    await db.lockProgress?.("media", chapterId);
    await db
      .prepare(
        `INSERT INTO chapter_media(chapter_id,source_hash,processor_version,codec,sample_rate,channels,bits_per_sample,duration_seconds,byte_length,rms,waveform,processed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET source_hash=excluded.source_hash,processor_version=excluded.processor_version,codec=excluded.codec,sample_rate=excluded.sample_rate,channels=excluded.channels,bits_per_sample=excluded.bits_per_sample,duration_seconds=excluded.duration_seconds,byte_length=excluded.byte_length,rms=excluded.rms,waveform=excluded.waveform,processed_at=excluded.processed_at
   WHERE chapter_media.source_hash<>excluded.source_hash OR chapter_media.processor_version<>excluded.processor_version`,
      )
      .run(
        chapterId,
        hash,
        PROCESSOR_VERSION,
        m.codec,
        m.sampleRate,
        m.channels,
        16,
        m.durationSeconds,
        m.byteLength,
        m.rms,
        JSON.stringify(m.waveform),
        new Date().toISOString(),
      );
  });
  return { chapterId, unchanged: false };
}
