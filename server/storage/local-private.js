import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, unlink } from "node:fs/promises";
import { resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
const unsafe = () =>
  Object.assign(Error("Private storage unavailable."), {
    code: "UNSAFE_STORAGE",
  });
// Flat, application-owned 0700 directory. No user filenames, URLs or subpaths.
export function localPrivateStorage(directory) {
  if (!isAbsolute(directory) || resolve(directory) === sep) throw unsafe();
  const root = resolve(directory);
  const forbidden = ["../../client", "../public"].map((p) =>
    fileURLToPath(new URL(p, import.meta.url)),
  );
  if (forbidden.some((p) => root === p || root.startsWith(p + sep)))
    throw unsafe();
  let canonical;
  async function base() {
    if (!canonical) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink()) throw unsafe();
      canonical = await realpath(root);
      if (
        forbidden.some((p) => canonical === p || canonical.startsWith(p + sep))
      )
        throw unsafe();
    }
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o077 ||
      stat.isSymbolicLink() ||
      (await realpath(root)) !== canonical
    )
      throw unsafe();
    return canonical;
  }
  async function path(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw unsafe();
    return `${await base()}/${key}.blob`;
  }
  async function read(key) {
    const h = await open(
      await path(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await h.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      await h.close();
      throw unsafe();
    }
    return h;
  }
  return {
    async create(key) {
      return open(
        await path(key),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    },
    read,
    async remove(key) {
      const p = await path(key);
      try {
        const s = await lstat(p);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw unsafe();
        await unlink(p);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    },
  };
}
