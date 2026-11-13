import { inspectWav } from "./audio.js";
export const PRIVATE_VALIDATOR_VERSION = 1;
export async function validatePrivateWav(handle) {
  // Deliberately narrow: canonical 44-byte PCM WAV header, mono/stereo signed
  // 16-bit samples, no ancillary/embedded chunks. Then inspect every PCM frame.
  const h = Buffer.alloc(44),
    stat = await handle.stat();
  const bad = () => {
    throw Object.assign(
      Error(
        "Use a complete PCM 16-bit WAV file (mono/stereo, 8–192 kHz). A canonical 44-byte header without metadata chunks is required.",
      ),
      { status: 422, mediaCode: "INVALID_AUDIO" },
    );
  };
  if (
    (await handle.read(h, 0, 44, 0)).bytesRead !== 44 ||
    h.toString("ascii", 0, 4) !== "RIFF" ||
    h.toString("ascii", 8, 12) !== "WAVE" ||
    h.toString("ascii", 12, 16) !== "fmt " ||
    h.readUInt32LE(16) !== 16 ||
    h.readUInt16LE(20) !== 1 ||
    h.toString("ascii", 36, 40) !== "data" ||
    h.readUInt32LE(4) + 8 !== stat.size ||
    h.readUInt32LE(40) + 44 !== stat.size ||
    h.readUInt32LE(28) !== h.readUInt32LE(24) * h.readUInt16LE(32)
  )
    bad();
  try {
    return await inspectWav(undefined, { handle, bins: 32 });
  } catch {
    bad();
  }
}
