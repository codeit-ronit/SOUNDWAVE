import { test } from "node:test";
import assert from "node:assert/strict";
import { backends, fixture, password } from "./phase2-helpers.js";
import { mailCodec } from "../services/mail.js";
import { hashToken } from "../services/tokens.js";
const signup = {
  email: "listener@example.com",
  displayName: "Listener",
  password,
};
async function latestToken(f, purpose) {
  const rows = await f.db
    .prepare(
      "SELECT payload FROM background_jobs WHERE kind='send_email' ORDER BY created_at DESC,id DESC",
    )
    .all();
  for (const row of rows) {
    const email = mailCodec(f.config.mailKey).decrypt(JSON.parse(row.payload));
    const match = new RegExp(purpose + "=([a-f0-9]{64})").exec(email.text);
    if (match) return { token: match[1], email };
  }
  throw Error("Expected encrypted token delivery");
}
for (const kind of backends) {
  test(`${kind}: verification tokens are encrypted in jobs, hashed in storage, one-use and purpose-bound`, async () => {
    const f = await fixture(kind, { email: true });
    try {
      const a = await f.client();
      assert.equal((await a.auth("register", signup)).status, 200);
      assert.equal(a.data.user.emailVerified, false);
      const { token } = await latestToken(f, "verify_email");
      const row = await f.db
        .prepare("SELECT * FROM account_tokens WHERE token_hash=?")
        .get(hashToken(token));
      assert.ok(row);
      assert.equal(row.purpose, "verify_email");
      const payloads = JSON.stringify(
        await f.db.prepare("SELECT payload FROM background_jobs").all(),
      );
      assert.ok(!payloads.includes(token));
      assert.ok(!payloads.includes(signup.email));
      await a
        .write("post", "/auth/reset-password", {
          token,
          password: "new strong test password!",
        })
        .expect(400);
      await a.write("post", "/auth/verify-email", { token }).expect(200);
      assert.equal(
        (await a.get("/auth/session")).body.user.emailVerified,
        true,
      );
      await a.write("post", "/auth/verify-email", { token }).expect(400);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: password recovery is generic, single-use, expires and revokes ALL sessions`, async () => {
    const f = await fixture(kind, { email: true });
    try {
      const a = await f.client();
      await a.auth("register", signup);
      const b = await f.client();
      await b.auth("login", { email: signup.email, password });
      const unknown = await b
        .write("post", "/auth/forgot-password", {
          email: "unknown@example.com",
        })
        .expect(202);
      const known = await b
        .write("post", "/auth/forgot-password", { email: signup.email })
        .expect(202);
      assert.deepEqual(known.body, unknown.body);
      const { token } = await latestToken(f, "reset_password");
      await b
        .write("post", "/auth/reset-password", { token, password: "short" })
        .expect(400);
      const fresh = "replacement strong password!";
      const raceClient = await f.client();
      const [resetResult, loginRace] = await Promise.all([
        b.write("post", "/auth/reset-password", { token, password: fresh }),
        raceClient.auth("login", { email: signup.email, password }),
      ]);
      assert.equal(resetResult.status, 200);
      assert.ok([200, 401].includes(loginRace.status));
      await raceClient.get("/library").expect(401);
      await a.get("/library").expect(401);
      await b.get("/library").expect(401);
      const c = await f.client();
      assert.equal(
        (await c.auth("login", { email: signup.email, password })).status,
        401,
      );
      assert.equal(
        (await c.auth("login", { email: signup.email, password: fresh }))
          .status,
        200,
      );
      await c
        .write("post", "/auth/reset-password", { token, password: fresh })
        .expect(400);
      await c
        .write("post", "/auth/forgot-password", { email: signup.email })
        .expect(202);
      const next = await latestToken(f, "reset_password");
      await f.db
        .prepare("UPDATE account_tokens SET expires_at=? WHERE token_hash=?")
        .run("2000-01-01T00:00:00.000Z", hashToken(next.token));
      await c
        .write("post", "/auth/reset-password", {
          token: next.token,
          password: fresh,
        })
        .expect(400);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: simultaneous token consumption succeeds once and resend invalidates older verification links`, async () => {
    const f = await fixture(kind, { email: true });
    try {
      const a = await f.client();
      await a.auth("register", signup);
      const old = await latestToken(f, "verify_email");
      await a.write("post", "/auth/request-verification", {}).expect(202);
      const rows = await f.db
        .prepare(
          "SELECT token_hash FROM account_tokens WHERE purpose='verify_email' AND consumed_at IS NULL",
        )
        .all();
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].token_hash, hashToken(old.token));
      await a
        .write("post", "/auth/verify-email", { token: old.token })
        .expect(400);
      const current = await latestToken(f, "verify_email");
      const outcomes = await Promise.all([
        a.write("post", "/auth/verify-email", { token: current.token }),
        a.write("post", "/auth/verify-email", { token: current.token }),
      ]);
      assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 400]);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: disabled delivery is explicit and never returns tokens or pretends to send mail`, async () => {
    const f = await fixture(kind);
    try {
      const a = await f.client();
      await a.auth("register", signup);
      await a
        .write("post", "/auth/forgot-password", { email: signup.email })
        .expect(503);
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM account_tokens").get())
          .n,
        0,
      );
    } finally {
      await f.close();
    }
  });
}
test("mail encryption authenticates ciphertext and rejects tampering/wrong keys", () => {
  const a = mailCodec("a".repeat(64)),
    b = mailCodec("b".repeat(64));
  const value = a.encrypt({ secret: "token" });
  assert.deepEqual(a.decrypt(value), { secret: "token" });
  assert.throws(() => b.decrypt(value));
  assert.throws(() => a.decrypt({ ...value, data: "AA==" }));
});
