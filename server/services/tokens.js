import { createHash } from "node:crypto";
export const hashToken = (value) =>
  createHash("sha256").update(value).digest("hex");
