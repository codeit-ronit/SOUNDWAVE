import { accountRepository } from "../repositories/account.js";
import { publicUser } from "./auth.js";
export const accountError = (status, code, message) =>
  Object.assign(new Error(message), { status, accountCode: code });
const serializeSettings = (row) => ({
  playbackSpeed: row?.playback_speed ?? 1,
  autoplayNext: row ? !!row.autoplay_next : true,
  defaultVolume: row?.default_volume ?? 0.8,
  updatedAt: row?.updated_at ?? null,
});
export function accountService(db) {
  const repo = accountRepository(db);
  const lock = async (user) => {
    if (!(await repo.lockOwner(user)))
      throw accountError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
  };
  return {
    async profile(user) {
      const row = await repo.profile(user);
      if (!row)
        throw accountError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
      return publicUser(row);
    },
    rename: (user, name) =>
      db.transaction(async () => {
        await lock(user);
        await repo.rename(user, name);
        return publicUser(await repo.profile(user));
      }),
    async settings(user) {
      return serializeSettings(await repo.settings(user));
    },
    saveSettings: (user, patch) =>
      db.transaction(async () => {
        // Lock the owner even before a settings row exists. Partial writes merge
        // under this lock, so independent-field changes cannot overwrite each other.
        await lock(user);
        const settings = {
          ...serializeSettings(await repo.settings(user)),
          ...patch,
        };
        await repo.save(user, settings);
        return serializeSettings(await repo.settings(user));
      }),
  };
}
