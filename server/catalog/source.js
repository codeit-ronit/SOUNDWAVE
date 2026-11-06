import { readFileSync } from "node:fs";

export const curatedBooks = JSON.parse(
  readFileSync(new URL("./curated.json", import.meta.url), "utf8"),
);
export const sourceError = (message) =>
  Object.assign(Error(message), { code: "INVALID_SOURCE" });
export function archiveAudioUrl(value, expectedItem) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !["archive.org", "www.archive.org"].includes(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw sourceError("Unapproved audio host");
  const parts = u.pathname.split("/");
  if (
    parts.length !== 4 ||
    parts[1] !== "download" ||
    !/^[a-zA-Z0-9_-]+$/.test(parts[2]) ||
    (expectedItem && parts[2] !== expectedItem)
  )
    throw sourceError("Unapproved archive item");
  const file = decodeURIComponent(parts[3]);
  if (!/^[a-zA-Z0-9_(). -]+\.mp3$/i.test(file) || file.includes(".."))
    throw sourceError("Unapproved audio filename");
  return {
    url: `https://archive.org/download/${parts[2]}/${encodeURIComponent(file)}`,
    item: parts[2],
    file,
  };
}
export function librivoxPage(value) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.hostname !== "librivox.org" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^\/[a-z0-9-]+\/$/i.test(u.pathname)
  )
    throw sourceError("Unapproved attribution URL");
  return "https://librivox.org" + u.pathname;
}
export function plainText(value, max = 3000) {
  return String(value || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (x) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[x],
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const v =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : "";
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
export async function sourceJson(
  url,
  { fetchImpl = fetch, limit = 5 * 1024 * 1024 } = {},
) {
  const r = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent":
        "SoundWavePortfolio/1.0 (https://github.com/codeit-ronit/SOUNDWAVE)",
      Accept: "application/json",
    },
  });
  if (!r.ok)
    throw Object.assign(Error("Catalog source unavailable"), {
      code: "UPSTREAM_UNAVAILABLE",
    });
  if (Number(r.headers.get("content-length")) > limit) {
    await r.body?.cancel();
    throw sourceError("Oversized source response");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > limit) {
      throw sourceError("Oversized source response");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
