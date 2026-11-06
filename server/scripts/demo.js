// Free portfolio hosting: supervise API and worker in one web-service container.
// This process sleeps with the host; use separate services for continuous jobs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const children = new Set();
let stopping = false;
let exitCode = 0;
let deadline;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode || 1);
  }, 20000);
  deadline.unref();
}

for (const entry of ["../index.js", "./worker.js"]) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(entry, import.meta.url))],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  children.add(child);
  child.once("error", () => {
    console.error("SoundWave demo child failed to start");
    stop(1);
  });
  child.once("exit", () => {
    children.delete(child);
    // A worker crash must not leave an apparently healthy API running alone.
    if (!stopping) stop(1);
    if (!children.size) {
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop());
