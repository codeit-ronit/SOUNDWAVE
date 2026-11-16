import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { backends } from "./phase2-helpers.js";
import { publicationFixture } from "./publishing-helpers.js";
import { publicationService, RIGHTS_TERMS } from "../services/publications.js";
import { provisionIdentity } from "../services/creator-operator.js";
import {
  exportTakedowns,
  reconcileTakedowns,
} from "../operations/takedowns.js";
import { createApp } from "../app.js";
import { migrate } from "../database/migrate.js";
import { telemetry } from "../telemetry.js";
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
for (const kind of backends) {
  test(
    `${kind}: publication hashes outside owner locks and revocation wins during verification`,
    { timeout: 10000 },
    async () => {
      const f = await publicationFixture(kind);
      let release;
      try {
        await f.submit();
        await f.approve();
        const p = (await f.c.get(f.base)).body.publication,
          opened = gate(),
          hold = gate();
        release = hold.resolve;
        let first = true;
        const service = publicationService(f.db, f.config, {
          ...f.service.storage,
          read: async (key) => {
            if (first) {
              first = false;
              opened.resolve();
              await hold.promise;
            }
            return f.service.storage.read(key);
          },
        });
        const pending = service.transition(
          { id: f.c.data.user.id },
          f.s.id,
          "publish",
          f.body(p.revision),
        );
        await opened.promise;
        // This must finish before release; a lock held across I/O would deadlock this test.
        const result = await f.moderator.write(
          "post",
          f.review + "/revoke",
          f.body(p.revision, {
            code: "rights_concern",
            note: "Revoke while checksum verification waits",
          }),
        );
        assert.equal(result.status, 200);
        hold.resolve();
        await assert.rejects(
          pending,
          (e) => e.permissionCode === "PUBLICATION_CONFLICT",
        );
        await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      } finally {
        release?.();
        await f.close();
      }
    },
  );
  test(`${kind}: publication rejects same-size inode replacement and in-place mutation after hashing`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      const p = (await f.c.get(f.base)).body.publication,
        out = await f.db
          .prepare(
            "SELECT object_key FROM private_media_outputs WHERE status='ready'",
          )
          .get(),
        path = join(f.config.privateMediaRoot, out.object_key + ".blob"),
        bytes = await readFile(path);
      let reads = 0;
      const replacement = publicationService(f.db, f.config, {
        ...f.service.storage,
        read: async (key) => {
          if (++reads === 2) {
            await writeFile(path + ".replacement", bytes, { mode: 0o600 });
            await rename(path + ".replacement", path);
          }
          return f.service.storage.read(key);
        },
      });
      await assert.rejects(
        replacement.transition(
          { id: f.c.data.user.id },
          f.s.id,
          "publish",
          f.body(p.revision),
        ),
        (e) => e.permissionCode === "NOT_READY",
      );
      let stats = 0;
      const inplace = publicationService(f.db, f.config, {
        ...f.service.storage,
        read: async (key) => {
          const h = await f.service.storage.read(key),
            original = h.stat.bind(h);
          h.stat = async (options) => {
            if (++stats === 3) {
              const old = await stat(path);
              await writeFile(path, Buffer.alloc(bytes.length));
              await utimes(path, old.atime, old.mtime);
            }
            return original(options);
          };
          return h;
        },
      });
      await assert.rejects(
        inplace.transition(
          { id: f.c.data.user.id },
          f.s.id,
          "publish",
          f.body(p.revision),
        ),
        (e) => e.permissionCode === "NOT_READY",
      );
      assert.equal((await f.c.get(f.base)).body.publication.state, "approved");
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM publication_audit WHERE story_id=?",
            )
            .get(f.s.id)
        ).n,
        2,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: internal diagnostics are admin-only, bounded and free of private identities`, async () => {
    const f = await publicationFixture(kind);
    try {
      const other = await f.client();
      await other.get("/internal/diagnostics").expect(401);
      await f.moderator.get("/internal/diagnostics").expect(403);
      await provisionIdentity(f.db, "role", f.c.data.user.id, "admin");
      await f.c.get("/stories?token=do-not-log-this");
      const d = (await f.c.get("/internal/diagnostics").expect(200)).body,
        text = JSON.stringify(d);
      for (const secret of [
        f.c.data.user.id,
        f.c.data.user.email,
        f.c.data.csrfToken,
        f.a.id,
        "do-not-log-this",
      ])
        assert.equal(text.includes(secret), false);
      assert.ok(d.metrics.some((m) => m.name === "db_query_ms"));
      assert.ok(d.metrics.length < 100);
      assert.ok(d.storage.outputReservedBytes > 0);
      assert.ok(d.backlog.processing.length > 0);
      telemetry(f.db).observe("http_ms", "arbitrary-user-" + randomUUID(), 1);
      assert.equal(
        telemetry(f.db)
          .snapshot()
          .some((m) => m.label.startsWith("arbitrary-")),
        false,
      );
      await f.c.get("/internal/diagnostics?owner=forged").expect(400);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: takedown reconciliation is monotonic, atomic, repeat-safe and quarantined`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      await f.publish();
      const q = createApp(f.db, {
        config: { ...f.config, releaseQuarantined: true },
      });
      await request(q).get(`/api/chapters/${f.ch.id}/stream`).expect(503);
      await request(q).get("/api/ready").expect(503);
      const ledger = { version: 1, entries: [{ id: f.s.id, revision: 99 }] };
      const original = f.db.prepare;
      f.db.prepare = (sql) =>
        sql.startsWith("INSERT INTO publication_audit")
          ? {
              run: async () => {
                throw Error("recovery audit failure");
              },
            }
          : original(sql);
      await assert.rejects(reconcileTakedowns(f.db, ledger), /recovery audit/);
      f.db.prepare = original;
      assert.equal((await f.c.get(f.base)).body.publication.state, "published");
      assert.deepEqual(await reconcileTakedowns(f.db, ledger), { changed: 1 });
      assert.deepEqual(await reconcileTakedowns(f.db, ledger), { changed: 0 });
      assert.equal((await f.c.get(f.base)).body.publication.revision, 100);
      assert.equal((await exportTakedowns(f.db)).entries[0].revision, 100);
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await assert.rejects(
        reconcileTakedowns(f.db, {
          version: 1,
          entries: [{ id: "1 OR 1=1", revision: 1 }],
        }),
        /Invalid/,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: future schema versions refuse writer startup without modifying listener state`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.db
        .prepare(
          "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES('999_future.sql','unknown',?)",
        )
        .run(new Date().toISOString());
      await assert.rejects(migrate(f.db), /newer\/unknown schema/);
      assert.equal(
        (await f.c.get(f.path)).body.processingIntent.status,
        "ready",
      );
    } finally {
      await f.close();
    }
  });
}
for (const kind of backends)
  test(`${kind}: published streaming rejects same-size corruption even after a warm integrity cache`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      await f.publish();
      const path = `/chapters/${f.ch.id}/stream`;
      await f.c.get(path).expect(200);
      const o = await f.db
        .prepare(
          "SELECT object_key,byte_size FROM private_media_outputs WHERE status='ready'",
        )
        .get();
      const key = join(f.config.privateMediaRoot, o.object_key + ".blob"),
        old = await stat(key);
      await writeFile(key, Buffer.alloc(o.byte_size));
      await utimes(key, old.atime, old.mtime);
      await f.c.get(path).set("Range", "bytes=0-11").expect(503);
    } finally {
      await f.close();
    }
  });
for (const kind of backends)
  test(
    `${kind}: bounded integrity admission rejects overload and releases capacity after failure`,
    { timeout: 10000 },
    async () => {
      const f = await publicationFixture(kind);
      const release = gate(),
        entered = gate();
      let count = 0;
      const promises = [];
      try {
        const { verifyPublicationFiles } =
          await import("../services/publication-integrity.js");
        const out = await f.db
          .prepare(
            "SELECT object_key,byte_size,checksum FROM private_media_outputs WHERE status='ready'",
          )
          .get();
        const storage = {
          read: async (key) => {
            if (++count === 4) entered.resolve();
            await release.promise;
            return f.service.storage.read(key);
          },
        };
        for (let i = 0; i < 4; i++)
          promises.push(verifyPublicationFiles(f.db, storage, [out]));
        await entered.promise;
        await assert.rejects(
          verifyPublicationFiles(f.db, storage, [out]),
          (e) => e.permissionCode === "INTEGRITY_BUSY",
        );
        release.resolve();
        for (const proof of await Promise.all(promises)) await proof.close();
        const proof = await verifyPublicationFiles(f.db, f.service.storage, [
          out,
        ]);
        await proof.close();
      } finally {
        release.resolve();
        for (const proof of await Promise.allSettled(promises))
          if (proof.status === "fulfilled") await proof.value.close();
        await f.close();
      }
    },
  );
for (const kind of backends)
  test(
    `${kind}: final publication CAS binds storage key as well as content identity`,
    { timeout: 10000 },
    async () => {
      const f = await publicationFixture(kind);
      const hold = gate(),
        entered = gate();
      let pending;
      try {
        await f.submit();
        await f.approve();
        const p = (await f.c.get(f.base)).body.publication,
          o = await f.db
            .prepare("SELECT * FROM private_media_outputs WHERE status='ready'")
            .get();
        let first = true;
        const svc = publicationService(f.db, f.config, {
          ...f.service.storage,
          read: async (key) => {
            if (first) {
              first = false;
              entered.resolve();
              await hold.promise;
            }
            return f.service.storage.read(key);
          },
        });
        pending = svc.transition(
          { id: f.c.data.user.id },
          f.s.id,
          "publish",
          f.body(p.revision),
        );
        await entered.promise;
        const key = "1".repeat(64);
        await writeFile(
          join(f.config.privateMediaRoot, key + ".blob"),
          Buffer.alloc(o.byte_size),
          { mode: 0o600 },
        );
        await f.db
          .prepare("UPDATE private_media_outputs SET object_key=? WHERE id=?")
          .run(key, o.id);
        hold.resolve();
        await assert.rejects(
          pending,
          (e) => e.permissionCode === "PUBLICATION_CONFLICT",
        );
        assert.equal(
          (await f.c.get(f.base)).body.publication.state,
          "approved",
        );
      } finally {
        hold.resolve();
        await pending?.catch(() => {});
        await f.close();
      }
    },
  );
test("quarantined worker refuses startup before database or Redis connections", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        (await import("node:url")).fileURLToPath(
          new URL("../scripts/worker.js", import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          RELEASE_QUARANTINED: "true",
          NODE_ENV: "development",
          DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/never_connect",
          REDIS_URL: "redis://127.0.0.1:1",
          EMAIL_MODE: "disabled",
        },
        timeout: 3000,
      },
    ),
    (e) =>
      e.code === 1 &&
      e.stderr.includes("Worker is quarantined") &&
      !e.stderr.includes("ECONNREFUSED"),
  );
});
for (const kind of backends)
  test(
    `${kind}: logout or session expiry during media verification prevents publication commit`,
    { timeout: 15000 },
    async () => {
      for (const reason of ["logout", "expiry"]) {
        const f = await publicationFixture(kind),
          entered = gate(),
          release = gate();
        let pending;
        try {
          await f.submit();
          await f.approve();
          const p = (await f.c.get(f.base)).body.publication;
          let first = true;
          const app = createApp(f.db, {
            config: f.config,
            privateStorage: {
              ...f.service.storage,
              read: async (key) => {
                if (first) {
                  first = false;
                  entered.resolve();
                  await release.promise;
                }
                return f.service.storage.read(key);
              },
            },
          });
          pending = request(app)
            .post("/api" + f.base + "/publish")
            .set("Cookie", f.c.cookie)
            .set("X-CSRF-Token", f.c.data.csrfToken)
            .send(f.body(p.revision))
            .then((r) => r);
          await entered.promise;
          if (reason === "logout")
            assert.equal((await f.c.auth("logout", {})).status, 204);
          else
            await f.db
              .prepare(
                "UPDATE sessions SET expires_at='1970-01-01T00:00:00.000Z' WHERE user_id=?",
              )
              .run(f.c.data.user.id);
          release.resolve();
          const r = await pending;
          assert.equal(r.status, 401);
          assert.equal(
            (
              await f.db
                .prepare(
                  "SELECT state FROM story_publications WHERE story_id=?",
                )
                .get(f.s.id)
            ).state,
            "approved",
          );
        } finally {
          release.resolve();
          await pending?.catch(() => {});
          await f.close();
        }
      }
    },
  );
