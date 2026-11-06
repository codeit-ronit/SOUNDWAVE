import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { hashToken } from "./tokens.js";
import { identityRepository } from "../repositories/identity.js";

// Not a password hash: the existing password verifier always rejects this marker.
// Keeps legacy SQLite user constraints intact without a destructive table rebuild.
export const GOOGLE_ONLY_PASSWORD = "external-only:google";
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 },
);
const fail = (message, status = 401) =>
  Object.assign(Error(message), { status });
export function googleTokenVerifier(clientId, { keySet = keys } = {}) {
  return async (credential) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(credential, keySet, {
        algorithms: ["RS256"],
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
        maxTokenAge: "1h",
        clockTolerance: 5,
        requiredClaims: [
          "sub",
          "email",
          "email_verified",
          "nonce",
          "iat",
          "exp",
        ],
      }));
    } catch (error) {
      if (error.code === "ERR_JWKS_TIMEOUT" || error.name === "TypeError")
        throw fail(
          "Google sign-in is temporarily unavailable. Please retry.",
          503,
        );
      throw fail("Google could not verify this sign-in. Please try again.");
    }
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      payload.email.length > 254 ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
      !/^[a-f0-9]{64}$/.test(payload.nonce || "") ||
      (payload.azp && payload.azp !== clientId)
    )
      throw fail("Google could not verify this sign-in. Please try again.");
    const email = payload.email.trim().toLowerCase();
    return {
      subject: payload.sub,
      email,
      name:
        (typeof payload.name === "string"
          ? payload.name.trim()
          : email.split("@")[0]
        )
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .slice(0, 80) || "Google listener",
      nonce: payload.nonce,
      emailAuthoritative:
        email.endsWith("@gmail.com") ||
        (typeof payload.hd === "string" && !!payload.hd),
    };
  };
}
export function googleIdentityService(
  db,
  config,
  auth,
  { verifyToken = googleTokenVerifier(config.googleClientId) } = {},
) {
  const repo = identityRepository(db);
  const enabled = () => {
    if (!config.googleClientId)
      throw fail("Google sign-in is not available.", 503);
  };
  const lockUser = (id) =>
    db
      .prepare(
        `SELECT * FROM users WHERE id=? ${db.dialect === "postgres" ? "FOR UPDATE" : ""}`,
      )
      .get(id);
  async function lockSession(hash) {
    const row = await db
      .prepare(
        `SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>? ${db.dialect === "postgres" ? "FOR UPDATE" : ""}`,
      )
      .get(hash, new Date().toISOString());
    if (!row) throw fail("Your session changed. Refresh and try Google again.");
  }
  return {
    async challenge(sessionHash) {
      enabled();
      const nonce = randomBytes(32).toString("hex"),
        expiresAt = new Date(Date.now() + 300000).toISOString();
      await db.transaction(async () => {
        await lockSession(sessionHash);
        await db
          .prepare(
            "INSERT INTO oauth_challenges(session_hash,nonce_hash,expires_at) VALUES(?,?,?) ON CONFLICT(session_hash) DO UPDATE SET nonce_hash=excluded.nonce_hash,expires_at=excluded.expires_at",
          )
          .run(sessionHash, hashToken(nonce), expiresAt);
      });
      return { clientId: config.googleClientId, nonce, expiresAt };
    },
    async signIn(credential, previous) {
      enabled();
      const claims = await verifyToken(credential);
      try {
        return await db.transaction(async () => {
          if (db.dialect === "postgres")
            await db
              .prepare("SELECT pg_advisory_xact_lock(824613,hashtext(?))")
              .get(claims.subject);
          const prior = previous ? await repo.session(previous) : null;
          if (!prior)
            throw fail("Your session changed. Refresh and try Google again.");
          const identity = await db
            .prepare(
              "SELECT user_id FROM oauth_identities WHERE provider='google' AND subject=?",
            )
            .get(claims.subject);
          if (
            identity &&
            prior.kind === "registered" &&
            prior.user_id !== identity.user_id
          )
            throw fail("Sign out before switching Google accounts.", 409);
          let user = identity
            ? await lockUser(identity.user_id)
            : prior.user_id
              ? await lockUser(prior.user_id)
              : null;
          await lockSession(previous);
          const consumed = await db
            .prepare(
              "DELETE FROM oauth_challenges WHERE session_hash=? AND nonce_hash=? AND expires_at>?",
            )
            .run(previous, hashToken(claims.nonce), new Date().toISOString());
          if (!consumed.changes)
            throw fail(
              "Google sign-in expired or was already used. Try Google again.",
            );
          if (identity) {
            if (!user || user.kind !== "registered")
              throw fail("This Google account is unavailable.");
            return auth.issue({ ...user, has_google: 1 }, previous);
          }
          if (user?.kind === "registered") {
            if (user.email !== claims.email)
              throw fail(
                "Use the Google account with the same email as this SoundWave account.",
                409,
              );
            if (
              await db
                .prepare(
                  "SELECT 1 FROM oauth_identities WHERE user_id=? AND provider='google'",
                )
                .get(user.id)
            )
              throw fail(
                "This account already has a different Google identity.",
                409,
              );
          } else {
            if (await repo.userByEmail(claims.email))
              throw fail(
                "An account already uses this email. Sign in with your password, then choose Link Google.",
                409,
              );
            const id = user?.kind === "guest" ? user.id : randomUUID();
            const newUser = {
              id,
              email: claims.email,
              password_hash: GOOGLE_ONLY_PASSWORD,
              display_name: claims.name,
              kind: "registered",
            };
            if (user?.kind === "guest") {
              if (!(await repo.upgradeGuest(newUser)).changes)
                throw fail("Your account changed. Refresh and try again.", 409);
            } else await repo.createUser(newUser);
            user = newUser;
          }
          if (claims.emailAuthoritative && !user.email_verified_at) {
            user.email_verified_at = new Date().toISOString();
            await db
              .prepare("UPDATE users SET email_verified_at=? WHERE id=?")
              .run(user.email_verified_at, user.id);
          }
          await db
            .prepare(
              "INSERT INTO oauth_identities(provider,subject,user_id,created_at) VALUES('google',?,?,?)",
            )
            .run(claims.subject, user.id, new Date().toISOString());
          return auth.issue({ ...user, has_google: 1 }, previous);
        });
      } catch (error) {
        if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw fail(
            "This account changed during sign-in. Refresh and try again.",
            409,
          );
        throw error;
      }
    },
  };
}
