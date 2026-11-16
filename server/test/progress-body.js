import request from "supertest";
import { randomUUID } from "node:crypto";
// Existing sequential fixtures now speak the required protocol explicitly.
// This reads once, never retries and never auto-resets completed progress.
// Concurrency/idempotency tests supply their own explicit revisions instead.
export async function progressBody(target, body, path = "/progress/101") {
  if (!body || Array.isArray(body) || typeof body !== "object") return body;
  const chapter = path.split("/").at(-1);
  const response = await (typeof target === "function"
    ? request(target).get(`/api/progress/${chapter}`)
    : target.get(`/progress/${chapter}`));
  return {
    clientId: randomUUID(),
    sequence: 1,
    expectedRevision: response.body?.progress?.revision ?? 0,
    ...body,
  };
}
