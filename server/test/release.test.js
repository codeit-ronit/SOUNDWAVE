import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { loadConfig } from "../config.js";
import { createReleaseRoles } from "../operations/release-roles.js";
import { connectDatabase } from "../database/index.js";
import { postgresAdapter } from "../database/adapter.js";
import { migrate, verifySchema } from "../database/migrate.js";
import { seedCatalog } from "../database/seed.js";
import { createApp } from "../app.js";

test("release startup selects read-only PostgreSQL verification and preserves explicit SQLite compatibility", async () => {
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: "https://demo.example",
      DATABASE_URL: "postgres://example",
    }).databaseInit,
    "verify",
  );
  assert.equal(loadConfig({}).databaseInit, "migrate");
  assert.throws(
    () => loadConfig({ DATABASE_INIT: "unknown" }),
    /DATABASE_INIT/,
  );
  await assert.rejects(
    connectDatabase({
      DATABASE_DRIVER: "sqlite",
      DATABASE_PATH: ":memory:",
      DATABASE_INIT: "verify",
    }),
    /requires PostgreSQL/,
  );
});
if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL release roles migrate separately while runtime starts without DDL or reseeding", async () => {
    const initial = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(initial.hostname) &&
        initial.pathname.startsWith("/soundwave_ci_"),
      "Disposable CI database required",
    );
    const admin = new pg.Client({ connectionString: initial.toString() });
    await admin.connect();
    const suffix = randomUUID().replaceAll("-", ""),
      name = "soundwave_ci_release_" + suffix,
      prefix = "m6_" + suffix.slice(0, 20),
      migratorPassword = randomBytes(24).toString("hex"),
      runtimePassword = randomBytes(24).toString("hex");
    let created = false,
      roles,
      writer,
      runtime,
      operator;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      const target = new URL(initial);
      target.pathname = "/" + name;
      operator = new pg.Client({ connectionString: target.toString() });
      await operator.connect();
      roles = await createReleaseRoles(operator, {
        prefix,
        migratorPassword,
        runtimePassword,
      });
      await assert.rejects(
        createReleaseRoles(operator, {
          prefix,
          migratorPassword,
          runtimePassword,
        }),
        /already exist/,
      );
      const migrationURL = new URL(target);
      migrationURL.username = roles.migrator;
      migrationURL.password = migratorPassword;
      const runtimeURL = new URL(target);
      runtimeURL.username = roles.runtime;
      runtimeURL.password = runtimePassword;
      // Runtime cannot bootstrap an empty schema, and never falls back to migrations.
      await assert.rejects(
        connectDatabase({
          NODE_ENV: "production",
          APP_ORIGIN: "https://demo.example",
          DATABASE_URL: runtimeURL.toString(),
        }),
        /matching migrator/,
      );
      writer = postgresAdapter(migrationURL.toString());
      await migrate(writer);
      await seedCatalog(writer);
      await writer
        .prepare(
          "UPDATE stories SET title='Release preserved custom system title' WHERE id=1",
        )
        .run();
      const revision = (
        await writer
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
      runtime = await connectDatabase({
        NODE_ENV: "production",
        APP_ORIGIN: "https://demo.example",
        DATABASE_URL: runtimeURL.toString(),
      });
      assert.equal(
        (await runtime.prepare("SELECT title FROM stories WHERE id=1").get())
          .title,
        "Release preserved custom system title",
      );
      assert.equal(
        (
          await runtime
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        revision,
      );
      await assert.rejects(
        runtime
          .prepare("CREATE TABLE public.forbidden_release_table(id INTEGER)")
          .run(),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        runtime
          .prepare("ALTER TABLE users ADD COLUMN forbidden_release_column TEXT")
          .run(),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        runtime
          .prepare("CREATE TEMP TABLE forbidden_release_temp(id INTEGER)")
          .run(),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        runtime.prepare("DELETE FROM schema_migrations").run(),
        (e) => e.code === "42501",
      );
      const user = "guest-" + randomUUID();
      await runtime
        .prepare(
          "INSERT INTO users(id,display_name,kind) VALUES(?,'Release guest','guest')",
        )
        .run(user);
      await runtime
        .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,1)")
        .run(user);
      assert.equal(
        (
          await runtime
            .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=?")
            .get(user)
        ).n,
        1,
      );
      const app = createApp(runtime, {
        config: loadConfig({
          NODE_ENV: "production",
          APP_ORIGIN: "https://demo.example",
          TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
        }),
      });
      const session = await request(app).get("/api/auth/session").expect(200);
      assert.match(session.headers["set-cookie"][0], /__Host-soundwave=/);
      assert.match(session.headers["set-cookie"][0], /Secure/);
      assert.match(session.headers["set-cookie"][0], /HttpOnly/);
      assert.match(session.headers["set-cookie"][0], /SameSite=Lax/);
      await request(app).get("/api/stories").expect(200);
      await request(app)
        .get("/api/chapters/101/stream")
        .set("Range", "bytes=0-11")
        .expect(206);
      await writer
        .prepare(
          "DELETE FROM schema_migrations WHERE version='018_publishing.sql'",
        )
        .run();
      await assert.rejects(verifySchema(runtime), /matching migrator/);
    } finally {
      await runtime?.close();
      await writer?.close();
      await operator?.end();
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      if (roles)
        for (const role of [roles.runtime, roles.migrator])
          await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  });
