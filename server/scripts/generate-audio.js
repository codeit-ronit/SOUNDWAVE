import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { catalog } from "../content/catalog.js";
const out = fileURLToPath(new URL("../public/audio/", import.meta.url));
mkdirSync(out, { recursive: true });
const manifest = {};
for (const story of catalog)
  for (const [index, chapter] of story.chapters.entries()) {
    const name = `${story.id}-${index + 1}`;
    const textPath = `${out}${name}.txt`;
    const audioPath = `${out}${name}.wav`;
    if (!existsSync(audioPath)) {
      writeFileSync(textPath, chapter.text);
      execFileSync("/usr/bin/say", [
        "-v",
        "Samantha",
        "-r",
        "155",
        "-f",
        textPath,
        "-o",
        audioPath,
        "--file-format=WAVE",
        "--data-format=LEI16@22050",
      ]);
      unlinkSync(textPath);
    }
    const wav = readFileSync(audioPath);
    let offset = 12,
      byteRate,
      dataSize;
    while (offset + 8 <= wav.length) {
      const kind = wav.toString("ascii", offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (kind === "fmt ") byteRate = wav.readUInt32LE(offset + 16);
      if (kind === "data") dataSize = size;
      offset += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) throw new Error(`Invalid audio: ${name}`);
    manifest[name] = {
      durationSeconds: dataSize / byteRate,
      audioUrl: `/audio/${name}.wav`,
    };
    console.log(`${name}: ${manifest[name].durationSeconds.toFixed(1)}s`);
  }
writeFileSync(`${out}manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
