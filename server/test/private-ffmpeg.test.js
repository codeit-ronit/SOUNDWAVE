import { test } from "node:test";
import assert from "node:assert/strict";
import { runBoundedMediaCommand } from "../media/private-ffmpeg.js";

const options = {
  config: { processingSeconds: 5, processingMemoryBytes: 268435456 },
};

test("bounded media command classifies missing executables with and without Linux prlimit", async () => {
  await assert.rejects(
    runBoundedMediaCommand("/nonexistent/soundwave-ffmpeg", [], options),
    (e) => e.code === "FFMPEG_UNAVAILABLE",
  );
});

test("bounded media command preserves ordinary nonzero exit failures", async () => {
  await assert.rejects(
    runBoundedMediaCommand(
      "/bin/ls",
      ["/nonexistent/soundwave-media-input"],
      options,
    ),
    (e) => e.code === "FFMPEG_FAILED",
  );
});
