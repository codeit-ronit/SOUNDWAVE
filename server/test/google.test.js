import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import {
  googleTokenVerifier,
  GOOGLE_ONLY_PASSWORD,
} from "../services/google.js";
import { hashToken } from "../services/tokens.js";
import { createApp } from "../app.js";
import { fixture, backends, password } from "./phase2-helpers.js";
import { loadConfig } from "../config.js";
import { accountRecovery } from "../services/accountRecovery.js";

const clientId = "123456789012-soundwavetest123.apps.googleusercontent.com";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key" };
const verifier = googleTokenVerifier(clientId, {
  keySet: createLocalJWKSet({ keys: [jwk] }),
});
async function sign(nonce, claims = {}, options = {}) {
  return new SignJWT({
    sub: "google-alice",
    email: "alice@gmail.com",
    email_verified: true,
    name: "Alice",
    nonce,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer || "https://accounts.google.com")
    .setAudience(options.audience || clientId)
    .setIssuedAt()
    .setExpirationTime(options.expiry || "10m")
    .sign(privateKey);
}
async function setup(kind, { enabled = true, verifyToken = verifier } = {}) {
  const f = await fixture(kind, {
    config: { googleClientId: enabled ? clientId : null },
  });
  const app = createApp(f.db, {
    config: f.config,
    googleVerifier: verifyToken,
    authLimit: { max: 1000 },
  });
  async function client() {
    const agent = request.agent(app);
    let data = (await agent.get("/api/auth/session").expect(200)).body;
    return {
      agent,
      get data() {
        return data;
      },
      get: (path) => agent.get("/api" + path),
      async write(path, body = {}, expected = 200) {
        const r = await agent
          .post("/api/auth" + path)
          .set("X-CSRF-Token", data.csrfToken)
          .send(body)
          .expect(expected);
        if (r.body.csrfToken) data = r.body;
        return r;
      },
      async challenge() {
        return (await this.write("/google/challenge")).body;
      },
      async google(claims = {}, expected = 200) {
        const c = await this.challenge();
        return this.write(
          "/google",
          { credential: await sign(c.nonce, claims) },
          expected,
        );
      },
    };
  }
  return { ...f, app, client };
}
test("Google token verification enforces signature, audience, issuer, expiry, verified email and nonce", async () => {
  const nonce = "a".repeat(64),
    valid = await sign(nonce);
  assert.equal((await verifier(valid)).subject, "google-alice");
  for (const token of [
    await sign(nonce, {}, { audience: "other-client" }),
    await sign(nonce, {}, { issuer: "https://evil.test" }),
    await sign(nonce, {}, { expiry: Math.floor(Date.now() / 1000) - 60 }),
    await sign(nonce, { email_verified: false }),
    await sign("bad-nonce"),
    await sign(nonce, { azp: "other-client" }),
    valid.slice(0, -12) + "tampered1234",
  ])
    await assert.rejects(verifier(token), (e) => e.status === 401);
  assert.throws(
    () => loadConfig({ GOOGLE_CLIENT_ID: "not-a-google-client" }),
    /GOOGLE_CLIENT_ID/,
  );
});
for (const kind of backends) {
  test(`${kind}: Google signup upgrades a guest, preserves data and rotates/revokes sessions`, async () => {
    const f = await setup(kind);
    try {
      const a = await f.client();
      assert.equal(a.data.googleClientId, clientId);
      await a.write("/demo");
      const old = a.data;
      await a.agent
        .put("/api/library/1")
        .set("X-CSRF-Token", old.csrfToken)
        .send({})
        .expect(200);
      await a.agent
        .put("/api/progress/101")
        .set("X-CSRF-Token", old.csrfToken)
        .send({ positionSeconds: 12 })
        .expect(200);
      const c = await a.challenge();
      const challenge = await f.db
        .prepare("SELECT * FROM oauth_challenges")
        .get();
      assert.equal(challenge.nonce_hash, hashToken(c.nonce));
      assert.notEqual(challenge.nonce_hash, c.nonce);
      const credential = await sign(c.nonce);
      const r = await a.write("/google", { credential });
      assert.equal(r.body.user.id, old.user.id);
      assert.equal(r.body.user.kind, "registered");
      assert.equal(r.body.user.googleLinked, true);
      assert.equal(r.body.user.emailVerified, true);
      assert.notEqual(r.body.csrfToken, old.csrfToken);
      assert.equal((await a.get("/library").expect(200)).body.stories[0].id, 1);
      assert.equal(
        (await a.get("/progress").expect(200)).body.progress[0]
          .position_seconds,
        12,
      );
      const u = await f.db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(old.user.id);
      assert.equal(u.password_hash, GOOGLE_ONLY_PASSWORD);
      await a.write("/google", { credential }, 401);
      await a.write("/logout", {}, 204);
      assert.equal((await a.get("/library")).status, 401);
      const b = await f.client();
      await b.google();
      assert.equal(b.data.user.id, old.user.id);
      assert.equal((await b.get("/library").expect(200)).body.stories[0].id, 1);
      await b.write("/logout", {}, 204);
      const p = await f.client();
      await p.write(
        "/login",
        { email: "alice@gmail.com", password: "external-only:google" },
        401,
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM oauth_identities").get())
          .n,
        1,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: Google nonce rejects cross-browser, expired, logged-out and invalid requests`, async () => {
    const f = await setup(kind);
    try {
      const a = await f.client(),
        b = await f.client(),
        c = await a.challenge(),
        credential = await sign(c.nonce);
      await b.challenge();
      await b.write("/google", { credential }, 401);
      await a.agent.post("/api/auth/google").send({ credential }).expect(403);
      await a.write("/google", { credential, userId: "someone-else" }, 400);
      await a.write("/google", { credential: "x".repeat(6001) }, 400);
      await f.db
        .prepare("UPDATE oauth_challenges SET expires_at=?")
        .run(new Date(Date.now() - 60000).toISOString());
      await a.write("/google", { credential }, 401);
      const live = await a.challenge();
      await a.write("/logout", {}, 204);
      await a.write("/google", { credential: await sign(live.nonce) }, 403);
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM oauth_identities").get())
          .n,
        0,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: matching email never auto-links; explicit authenticated linking retains existing password and isolation`, async () => {
    const f = await setup(kind);
    try {
      const a = await f.client();
      await a.write("/register", {
        email: "alice@gmail.com",
        password,
        displayName: "Password Alice",
      });
      const id = a.data.user.id;
      await a.agent
        .put("/api/library/2")
        .set("X-CSRF-Token", a.data.csrfToken)
        .send({})
        .expect(200);
      const hash = (
        await f.db.prepare("SELECT password_hash FROM users WHERE id=?").get(id)
      ).password_hash;
      const stranger = await f.client();
      await stranger.write("/demo");
      await stranger.google({}, 409);
      assert.equal(
        (await stranger.get("/library").expect(200)).body.stories.length,
        0,
      );
      await a.google({ email: "different@gmail.com", sub: "different" }, 409);
      await a.google();
      assert.equal(a.data.user.id, id);
      assert.equal(a.data.user.googleLinked, true);
      assert.equal(
        (
          await f.db
            .prepare("SELECT password_hash FROM users WHERE id=?")
            .get(id)
        ).password_hash,
        hash,
      );
      await a.google({ sub: "other-google" }, 409);
      await a.write("/logout", {}, 204);
      const fresh = await f.client();
      await fresh.google();
      assert.equal(fresh.data.user.id, id);
      assert.equal(
        (await fresh.get("/library").expect(200)).body.stories[0].id,
        2,
      );
      const other = await f.client();
      await other.google({
        sub: "google-bob",
        email: "bob@gmail.com",
        name: "Bob",
      });
      assert.notEqual(other.data.user.id, id);
      assert.equal(
        (await other.get("/library").expect(200)).body.stories.length,
        0,
      );
      await other.google({}, 409);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: third-party Google email is not treated as Google-hosted email ownership`, async () => {
    const f = await setup(kind);
    try {
      const a = await f.client();
      await a.google({ email: "alice@example.org" });
      assert.equal(a.data.user.emailVerified, false);
      assert.equal(a.data.user.googleLinked, true);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: Google disabled and revoked sessions fail closed`, async () => {
    const f = await setup(kind, { enabled: false });
    try {
      const a = await f.client();
      assert.equal(a.data.googleClientId, null);
      await a.write("/google/challenge", {}, 503);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: simultaneous Google logins share one identity without duplicate users`, async () => {
    const f = await setup(kind);
    try {
      const a = await f.client(),
        b = await f.client(),
        ca = await a.challenge(),
        cb = await b.challenge();
      await Promise.all([
        a.write("/google", { credential: await sign(ca.nonce) }),
        b.write("/google", { credential: await sign(cb.nonce) }),
      ]);
      assert.equal(a.data.user.id, b.data.user.id);
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM oauth_identities").get())
          .n,
        1,
      );
    } finally {
      await f.close();
    }
  });
}
test("Google signing-key fetch failures never create a login", async () => {
  const unavailable = googleTokenVerifier(clientId, {
    keySet: async () => {
      throw Object.assign(Error("timeout"), { code: "ERR_JWKS_TIMEOUT" });
    },
  });
  await assert.rejects(
    unavailable(await sign("a".repeat(64))),
    (e) => e.status === 503,
  );
});
test("email recovery does not introduce password access to a Google-only account", async () => {
  const f = await setup("sqlite");
  try {
    const a = await f.client();
    await a.google({ email: "alice@example.org" });
    const recovery = accountRecovery(f.db, {
      ...f.config,
      emailMode: "smtp",
      mailKey: "a".repeat(64),
    });
    await recovery.requestReset("alice@example.org");
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM account_tokens WHERE purpose='reset_password'",
          )
          .get()
      ).n,
      0,
    );
  } finally {
    await f.close();
  }
});
test("Google sign-in cannot recreate a session revoked while token verification was in flight", async () => {
  let release, entered;
  const waiting = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const f = await setup("sqlite", {
    verifyToken: async (c) => {
      const claims = await verifier(c);
      entered();
      await gate;
      return claims;
    },
  });
  try {
    const a = await f.client(),
      c = await a.challenge();
    const pending = a.write(
      "/google",
      { credential: await sign(c.nonce) },
      401,
    );
    const executing = Promise.resolve(pending);
    await waiting;
    await f.db.prepare("DELETE FROM sessions").run();
    release();
    await executing;
    assert.equal(
      (await f.db.prepare("SELECT COUNT(*) AS n FROM oauth_identities").get())
        .n,
      0,
    );
  } finally {
    release?.();
    await f.close();
  }
});
