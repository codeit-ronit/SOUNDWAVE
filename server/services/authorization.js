import { creatorRepository } from "../repositories/creators.js";
export const permissionError = (status, code, message) =>
  Object.assign(Error(message), { status, permissionCode: code });
export function authorizationService(db) {
  const repo = creatorRepository(db);
  async function registered(principal, lock = false) {
    if (!principal?.id)
      throw permissionError(401, "AUTH_REQUIRED", "Sign in to continue.");
    const account = await repo.account(principal.id, lock);
    if (!account || account.kind !== "registered")
      throw permissionError(
        403,
        "REGISTERED_REQUIRED",
        "A registered account is required for creator access.",
      );
    return account;
  }
  async function creator(principal) {
    await registered(principal);
    const profile = await repo.profile(principal.id);
    if (profile?.status !== "active")
      throw permissionError(
        403,
        "CREATOR_INACTIVE",
        "Active creator access is required.",
      );
    return profile;
  }
  return {
    registered,
    creator,
    // Call inside the same transaction as the future protected write. Lock the
    // owner before checking status so concurrent suspension cannot slip past it.
    ownedStory: (principal, id) =>
      db.transaction(async () => {
        await registered(principal, true);
        await creator(principal);
        const story = await repo.story(id);
        if (
          !story ||
          story.ownership_kind !== "creator" ||
          story.owner_id !== principal.id
        )
          throw permissionError(404, "STORY_NOT_FOUND", "Story not found.");
        return story;
      }),
    staff: async (principal, allowed) => {
      const account = await registered(principal);
      // No arbitrary permission names or implicit creator/staff inheritance.
      if (
        !Array.isArray(allowed) ||
        !allowed.length ||
        allowed.some((role) => !["admin", "moderator"].includes(role)) ||
        !allowed.includes(account.platform_role)
      )
        throw permissionError(
          403,
          "STAFF_REQUIRED",
          "Staff permission required.",
        );
      return account;
    },
  };
}
