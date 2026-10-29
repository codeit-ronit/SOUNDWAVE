import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const N = 131072,
  r = 8,
  p = 1,
  length = 64;
let active = 0;
// Bound memory-hard work even before introducing distributed throttling.
async function derive(password, salt) {
  if (active >= 2) {
    const error = new Error("Authentication busy. Please retry shortly.");
    error.status = 503;
    throw error;
  }
  active++;
  try {
    return await scrypt(password, salt, length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } finally {
    active--;
  }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${N}$${r}$${p}$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password, hash) {
  const parts = hash?.split("$");
  // Fixed supported cost prevents corrupt persisted parameters causing excessive work.
  const valid =
    parts?.length === 6 &&
    parts[0] === "scrypt" &&
    Number(parts[1]) === N &&
    Number(parts[2]) === r &&
    Number(parts[3]) === p &&
    /^[a-f0-9]{32}$/.test(parts[4]) &&
    /^[a-f0-9]{128}$/.test(parts[5]);
  const key = await derive(
    password,
    valid ? parts[4] : "00000000000000000000000000000000",
  );
  return !!valid && timingSafeEqual(key, Buffer.from(parts[5], "hex"));
}
