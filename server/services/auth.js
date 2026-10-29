import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { identityRepository } from "../repositories/identity.js";
import { hashPassword, verifyPassword } from "./passwords.js";
const token = () => randomBytes(32).toString("hex");
export const hashToken = (value) =>
  createHash("sha256").update(value).digest("hex");
export const publicUser = (row) => ({
  id: row.user_id || row.id,
  email: row.email,
  displayName: row.display_name,
  kind: row.kind,
});
export const sameToken = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  /^[a-f0-9]{64}$/.test(a) &&
  /^[a-f0-9]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function authService(db, config) {
  const repo = identityRepository(db);
  const issue = async (user, previous) => {
    const raw = token();
    const csrf = token();
    const seconds = !user.id
      ? 600
      : user.kind === "guest"
        ? config.guestSeconds
        : config.sessionSeconds;
    const expires = new Date(Date.now() + seconds * 1000).toISOString();
    await db.transaction(async () => {
      if (previous) await repo.deleteSession(previous);
      await repo.createSession({
        token_hash: hashToken(raw),
        user_id: user.id || null,
        csrf_token: csrf,
        expires_at: expires,
      });
    });
    return {
      raw,
      csrfToken: csrf,
      user: user.id ? publicUser(user) : null,
      expiresAt: expires,
      seconds,
    };
  };
  return {
    issue,
    lookup: (raw) =>
      /^[a-f0-9]{64}$/.test(raw || "") ? repo.session(hashToken(raw)) : null,
    logout: (hash) => repo.deleteSession(hash),
    guest: async (previous) => {
      if (!config.demoEnabled) {
        const error = Error("Demo mode is disabled.");
        error.status = 403;
        throw error;
      }
      const user = {
        id: randomUUID(),
        email: null,
        password_hash: null,
        display_name: "Demo listener",
        kind: "guest",
      };
      return db.transaction(async () => {
        await repo.createUser(user);
        return issue(user, previous);
      });
    },
    register: async ({ email, password, displayName }, previous) => {
      const password_hash = await hashPassword(password);
      const user = {
        id: randomUUID(),
        email,
        password_hash,
        display_name: displayName,
        kind: "registered",
      };
      try {
        return await db.transaction(async () => {
          const prior = previous ? await repo.session(previous) : null;
          if (prior?.kind === "guest") {
            user.id = prior.user_id;
            const updated = await repo.upgradeGuest(user);
            if (!updated.changes) {
              const conflict = Error(
                "This session changed. Refresh and retry.",
              );
              conflict.status = 409;
              throw conflict;
            }
          } else await repo.createUser(user);
          return issue(user, previous);
        });
      } catch (error) {
        if (
          error.code === "23505" ||
          error.code === "SQLITE_CONSTRAINT_UNIQUE"
        ) {
          const conflict = Error(
            "An account could not be created with these details.",
          );
          conflict.status = 409;
          throw conflict;
        }
        throw error;
      }
    },
    login: async ({ email, password }, previous) => {
      const user = await repo.userByEmail(email);
      if (!(await verifyPassword(password, user?.password_hash))) {
        const error = Error("Invalid email or password.");
        error.status = 401;
        throw error;
      }
      return issue(user, previous);
    },
  };
}
