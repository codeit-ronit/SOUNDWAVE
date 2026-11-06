import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDatabase } from "../database/index.js";
test("PostgreSQL is required by default and SQLite compatibility must be explicit", async () => {
  await assert.rejects(connectDatabase({}), /DATABASE_URL for PostgreSQL/);
  await assert.rejects(
    connectDatabase({ DATABASE_DRIVER: "postgres", DATABASE_PATH: ":memory:" }),
    /DATABASE_URL for PostgreSQL/,
  );
  const db = await connectDatabase({
    DATABASE_DRIVER: "sqlite",
    DATABASE_PATH: ":memory:",
  });
  try {
    assert.equal(db.dialect, "sqlite");
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM stories").get()).n,
      6,
    );
  } finally {
    await db.close();
  }
});
