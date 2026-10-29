import { test } from "node:test";
import assert from "node:assert/strict";
import { retryConnection } from "../database/retry.js";
test("startup retries transient database readiness failures with bounded delays", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryConnection(
    async () => {
      if (++calls < 3)
        throw Object.assign(Error("starting"), { code: "57P03" });
      return "connected";
    },
    { sleep: async (ms) => delays.push(ms) },
  );
  assert.equal(result, "connected");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});
test("startup never retries schema/configuration errors and stops after its attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    retryConnection(
      async () => {
        calls++;
        throw Error("checksum mismatch");
      },
      { sleep: async () => {} },
    ),
    /checksum mismatch/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryConnection(
      async () => {
        calls++;
        throw Object.assign(Error("down"), { code: "ECONNREFUSED" });
      },
      { attempts: 3, sleep: async () => {} },
    ),
    /down/,
  );
  assert.equal(calls, 3);
});
