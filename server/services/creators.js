import { creatorRepository } from "../repositories/creators.js";
import { authorizationService, permissionError } from "./authorization.js";
const serialize = (row) =>
  row
    ? {
        displayName: row.display_name,
        bio: row.bio,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
export function creatorService(db) {
  const repo = creatorRepository(db),
    auth = authorizationService(db);
  async function view(principal) {
    const account = await repo.account(principal.id);
    if (!account)
      throw permissionError(401, "AUTH_REQUIRED", "Sign in to continue.");
    return {
      eligible: account.kind === "registered",
      platformRole: account.platform_role,
      creator: serialize(await repo.profile(principal.id)),
    };
  }
  async function writable(principal) {
    await auth.registered(principal, true);
    const profile = await repo.profile(principal.id);
    if (profile?.status === "suspended")
      throw permissionError(
        403,
        "CREATOR_SUSPENDED",
        "Creator access is suspended. Contact the operator.",
      );
    return profile;
  }
  return {
    view,
    activate: (principal, name, bio) =>
      db.transaction(async () => {
        const profile = await writable(principal);
        if (!profile) await repo.create(principal.id, name, bio);
        else if (profile.status === "inactive")
          await repo.status(principal.id, "active");
        return view(principal);
      }),
    edit: (principal, name, bio) =>
      db.transaction(async () => {
        await auth.registered(principal, true);
        await auth.creator(principal);
        await repo.edit(principal.id, name, bio);
        return view(principal);
      }),
    deactivate: (principal) =>
      db.transaction(async () => {
        const profile = await writable(principal);
        if (!profile)
          throw permissionError(
            404,
            "CREATOR_NOT_FOUND",
            "Creator profile not found.",
          );
        if (profile.status !== "inactive")
          await repo.status(principal.id, "inactive");
        return view(principal);
      }),
  };
}
