import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
const fault = (code) => Object.assign(Error(code), { code });
// No shell; only fixed flags, pipe input, checked inherited descriptors and fixed codecs.
async function command(
  binary,
  args,
  { config, signal, input, output, fd } = {},
) {
  const hard = process.platform === "linux" && existsSync("/usr/bin/prlimit");
  const program = hard ? "/usr/bin/prlimit" : binary;
  const argv = hard
    ? [
        `--as=${Math.max(config.processingMemoryBytes * 4, 1073741824)}`,
        `--cpu=${config.processingSeconds}`,
        "--",
        binary,
        ...args,
      ]
    : args;
  const child = spawn(program, argv, {
    stdio: ["pipe", "pipe", "pipe", ...(fd === undefined ? [] : [fd])],
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH,
      LANG: "C",
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
    },
  });
  let reason,
    stopped = false,
    stderrBytes = 0;
  const kill = (code) => {
    if (stopped) return;
    reason ??= code;
    try {
      process.platform === "win32"
        ? child.kill("SIGKILL")
        : process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const abort = () => kill("PROCESSING_ABORTED");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => kill("FFMPEG_TIMEOUT"),
    config.processingSeconds * 1000,
  );
  timer.unref();
  // Hard virtual-memory/CPU limits on Linux; RSS guard also bounds Mac execution.
  let polling = false;
  const memory = setInterval(() => {
    if (polling || !child.pid) return;
    polling = true;
    execFile(
      "/bin/ps",
      ["-o", "rss=", "-p", String(child.pid)],
      { timeout: 500, maxBuffer: 1024 },
      (e, text) => {
        polling = false;
        if (!e && Number(text.trim()) * 1024 > config.processingMemoryBytes)
          kill("FFMPEG_MEMORY");
      },
    );
  }, 100);
  memory.unref();
  child.stderr.on("data", (b) => {
    stderrBytes += b.length;
    if (stderrBytes > 65536) kill("FFMPEG_STDERR_LIMIT");
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", (e) => {
      reason =
        e.code === "ENOENT" ? "FFMPEG_UNAVAILABLE" : "FFMPEG_SPAWN_FAILED";
      reject(fault(reason));
    });
    child.once("close", (code) => {
      stopped = true;
      return code === 0 && !reason
        ? resolve()
        : reject(fault(reason || "FFMPEG_FAILED"));
    });
  });
  const inputPromise = input
    ? pipeline(input, child.stdin)
    : Promise.resolve(child.stdin.end());
  const outputPromise = pipeline(
    child.stdout,
    output ||
      new Writable({
        write(b, e, cb) {
          cb();
        },
      }),
  );
  // Observe all pipes immediately and kill on limit/I/O errors; wait for process exit
  // before releasing leases or removing an output a subprocess could still write.
  const watch = (p) =>
    p.catch((e) => {
      kill(e.code || "FFMPEG_IO");
      throw e;
    });
  try {
    const results = await Promise.allSettled([
      ended,
      watch(inputPromise),
      watch(outputPromise),
    ]);
    const bad = results.find((r) => r.status === "rejected");
    if (bad) throw fault(reason || bad.reason.code || "FFMPEG_IO");
  } finally {
    clearTimeout(timer);
    clearInterval(memory);
    signal?.removeEventListener("abort", abort);
    child.stdin.destroy();
    child.stdout.destroy();
  }
}
async function digest(handle) {
  const hash = createHash("sha256");
  for await (const b of handle.createReadStream({ autoClose: false, start: 0 }))
    hash.update(b);
  return hash.digest("hex");
}
export async function transcodePrivateWav(
  storage,
  source,
  output,
  config,
  { signal, onStage, onOutput } = {},
) {
  let input, writer, probe, decode, hashHandle;
  try {
    input = await storage.read(source.object_key);
    if (
      (await input.stat()).size !== source.byte_size ||
      (await digest(input)) !== source.checksum
    )
      throw fault("SOURCE_HASH");
    await onStage?.("transcoding");
    writer = await storage.create(output.object_key);
    let count = 0;
    const hash = createHash("sha256");
    const bound = new Transform({
      transform(b, e, cb) {
        count += b.length;
        if (count > output.reserved_bytes) return cb(fault("OUTPUT_TOO_LARGE"));
        hash.update(b);
        if (onOutput && !this.announced) {
          this.announced = true;
          this.push(b);
          Promise.resolve(onOutput()).then(() => cb(), cb);
        } else cb(null, b);
      },
    });
    const file = writer.createWriteStream({ autoClose: true, flush: true });
    const fileWritten = pipeline(bound, file);
    const sourceInput = input.createReadStream({ autoClose: false, start: 0 }),
      fedHash = createHash("sha256");
    let fedBytes = 0;
    sourceInput.on("data", (b) => {
      fedBytes += b.length;
      fedHash.update(b);
    });
    const encoded = command(
      config.ffmpegPath,
      [
        "-nostdin",
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "pipe",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "96k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-threads",
        "1",
        "-f",
        "mp3",
        "pipe:1",
      ],
      {
        config,
        signal,
        input: sourceInput,
        output: bound,
      },
    );
    const rs = await Promise.allSettled([encoded, fileWritten]);
    const bad = rs.find((r) => r.status === "rejected");
    if (bad) throw bad.reason;
    if (
      fedBytes !== source.byte_size ||
      fedHash.digest("hex") !== source.checksum
    )
      throw fault("SOURCE_HASH");
    writer = null;
    await input.close();
    input = null;
    if (!count) throw fault("OUTPUT_INVALID");
    await onStage?.("validating");
    probe = await storage.read(output.object_key);
    let text = "",
      length = 0;
    await command(
      config.ffprobePath,
      [
        "-v",
        "error",
        "-f",
        "mp3",
        "-show_entries",
        "stream=codec_name,codec_type,sample_rate,channels",
        "-of",
        "json",
        "/dev/fd/3",
      ],
      {
        config,
        signal,
        fd: probe.fd,
        output: new Writable({
          write(b, e, cb) {
            length += b.length;
            if (length > 16384) return cb(fault("OUTPUT_INVALID"));
            text += b.toString();
            cb();
          },
        }),
      },
    );
    await probe.close();
    probe = null;
    let info;
    try {
      info = JSON.parse(text);
    } catch {
      throw fault("OUTPUT_INVALID");
    }
    if (
      info.streams?.length !== 1 ||
      info.streams[0].codec_name !== "mp3" ||
      Number(info.streams[0].sample_rate) !== 44100 ||
      info.streams[0].channels !== 2
    )
      throw fault("OUTPUT_INVALID");
    decode = await storage.read(output.object_key);
    let pcm = 0;
    const maxPcm = Math.ceil((source.duration_seconds + 2) * 44100 * 4);
    await command(
      config.ffmpegPath,
      [
        "-nostdin",
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-f",
        "mp3",
        "-i",
        "/dev/fd/3",
        "-map",
        "0:a:0",
        "-vn",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        config,
        signal,
        fd: decode.fd,
        output: new Writable({
          write(b, e, cb) {
            pcm += b.length;
            cb(pcm > maxPcm ? fault("OUTPUT_INVALID") : null);
          },
        }),
      },
    );
    await decode.close();
    decode = null;
    const duration = pcm / (44100 * 4);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      Math.abs(duration - source.duration_seconds) > 0.25
    )
      throw fault("OUTPUT_INVALID");
    hashHandle = await storage.read(output.object_key);
    const actual = await digest(hashHandle);
    if (
      actual !== hash.digest("hex") ||
      (await hashHandle.stat()).size !== count
    )
      throw fault("OUTPUT_INVALID");
    return { byteSize: count, checksum: actual, durationSeconds: duration };
  } catch (e) {
    if (e.code === "ENOENT") throw fault("SOURCE_MISSING");
    throw e;
  } finally {
    for (const h of [input, writer, probe, decode, hashHandle])
      await h?.close().catch(() => {});
  }
}
export { command as runBoundedMediaCommand };
