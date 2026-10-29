import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "soundwave-offline-shell",
      apply: "build",
      closeBundle() {
        const dist = resolve(import.meta.dirname, "dist");
        const assets = readdirSync(resolve(dist, "assets")).map(
          (name) => `/assets/${name}`,
        );
        const files = [
          "/index.html",
          "/offline.html",
          "/manifest.webmanifest",
          "/icons/logo.svg",
          "/icons/icon-192.png",
          "/icons/icon-512.png",
          ...assets,
        ];
        const worker = readFileSync(resolve(dist, "sw.js"), "utf8");
        const hash = createHash("sha256");
        for (const path of files)
          hash.update(readFileSync(resolve(dist, path.slice(1))));
        writeFileSync(
          resolve(dist, "sw.js"),
          worker
            .replace("/* PRECACHE */ []", JSON.stringify(files))
            .replace("BUILD_HASH", hash.digest("hex").slice(0, 12)),
        );
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/audio": "http://127.0.0.1:3001",
    },
  },
  test: { environment: "jsdom", restoreMocks: true },
});
