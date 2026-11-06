import { test, expect } from "vitest";
import {
  validateDownload,
  MAX_CHAPTER_BYTES,
  MAX_DOWNLOAD_BYTES,
} from "./downloadAudio";
test("offline MP3 admission checks complete bytes and audio signature within bounded storage", () => {
  const bytes = new Uint8Array(100);
  bytes.set([0x49, 0x44, 0x33]);
  expect(() => validateDownload(bytes.buffer, "audio/mpeg", 100)).not.toThrow();
  expect(() => validateDownload(bytes.buffer, "audio/mpeg", 99)).toThrow(
    /incomplete/,
  );
  const html = new TextEncoder().encode(
    "<html>an error page with enough bytes</html>",
  );
  expect(() =>
    validateDownload(html.buffer, "audio/mpeg", html.length),
  ).toThrow(/MP3/);
  expect(() => validateDownload(bytes.buffer, "text/html", 100)).toThrow(
    /format/,
  );
  expect(MAX_CHAPTER_BYTES).toBe(25 * 1024 * 1024);
  expect(MAX_DOWNLOAD_BYTES).toBe(200 * 1024 * 1024);
});
