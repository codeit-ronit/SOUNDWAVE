import { randomBytes } from "node:crypto";
import { hashToken } from "./tokens.js";
import { hashPassword } from "./passwords.js";
import { jobQueue } from "../jobs/queue.js";
import { mailCodec } from "./mail.js";
const fail = () =>
  Object.assign(Error("This link is invalid or expired. Request a new one."), {
    status: 400,
  });
export function accountRecovery(db, config) {
  const codec = config.emailMode === "smtp" ? mailCodec(config.mailKey) : null;
  const lockUser = (id) =>
    db
      .prepare(
        `SELECT * FROM users WHERE id=? ${db.dialect === "postgres" ? "FOR UPDATE" : ""}`,
      )
      .get(id);
  async function issue(user, purpose) {
    if (!codec) return false;
    const raw = randomBytes(32).toString("hex"),
      expiresAt = new Date(
        Date.now() + (purpose === "reset_password" ? 30 * 60000 : 24 * 3600000),
      ).toISOString();
    // Fragment tokens stay out of HTTP access logs and Referer headers. The frontend
    // removes them from browser history before exchanging them over a POST.
    const link = `${config.origin}/account#${purpose}=${raw}`;
    await db.transaction(async () => {
      await lockUser(user.id);
      // Resending invalidates all previous links of this purpose, including queued email.
      await db
        .prepare(
          "UPDATE account_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL",
        )
        .run(new Date().toISOString(), user.id, purpose);
      await db
        .prepare(
          "INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          hashToken(raw),
          user.id,
          purpose,
          expiresAt,
          new Date().toISOString(),
        );
      const payload = codec.encrypt({
        to: user.email,
        expiresAt,
        subject:
          purpose === "reset_password"
            ? "Reset your SoundWave password"
            : "Verify your SoundWave email",
        text: `${purpose === "reset_password" ? "Reset your password" : "Verify your email"} using this one-time link:\n\n${link}\n\nIf you did not request this, ignore this email.`,
      });
      await jobQueue(db).enqueue("send_email", {
        owner: user.id,
        payload,
        key: `account-token:${hashToken(raw)}`,
      });
    });
    return true;
  }
  async function token(raw, purpose, action) {
    if (!/^[a-f0-9]{64}$/.test(raw || "")) throw fail();
    const hash = hashToken(raw),
      row = await db
        .prepare(
          "SELECT user_id FROM account_tokens WHERE token_hash=? AND purpose=?",
        )
        .get(hash, purpose);
    if (!row) throw fail();
    return db.transaction(async () => {
      const user = await lockUser(row.user_id);
      const claimed = await db
        .prepare(
          "UPDATE account_tokens SET consumed_at=? WHERE token_hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>?",
        )
        .run(new Date().toISOString(), hash, purpose, new Date().toISOString());
      if (!claimed.changes || !user || user.kind !== "registered") throw fail();
      await action(user);
    });
  }
  return {
    issue,
    async requestReset(email) {
      if (!codec)
        throw Object.assign(Error("Email delivery is not configured."), {
          status: 503,
        });
      const user = await db
        .prepare("SELECT * FROM users WHERE email=? AND kind='registered'")
        .get(email);
      if (user) await issue(user, "reset_password");
    },
    async requestVerification(userId) {
      if (!codec)
        throw Object.assign(Error("Email delivery is not configured."), {
          status: 503,
        });
      const user = await db
        .prepare("SELECT * FROM users WHERE id=? AND kind='registered'")
        .get(userId);
      if (user && !user.email_verified_at) await issue(user, "verify_email");
    },
    async verify(raw) {
      await token(raw, "verify_email", async (user) => {
        await db
          .prepare("UPDATE users SET email_verified_at=? WHERE id=?")
          .run(new Date().toISOString(), user.id);
      });
    },
    async reset(raw, password) {
      const hash = await hashPassword(password);
      await token(raw, "reset_password", async (user) => {
        await db
          .prepare("UPDATE users SET password_hash=? WHERE id=?")
          .run(hash, user.id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
        await db
          .prepare(
            "UPDATE account_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL",
          )
          .run(new Date().toISOString(), user.id, "reset_password");
      });
    },
  };
}
