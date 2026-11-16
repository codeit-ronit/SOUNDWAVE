// Trusted operator interface only. Never mount this service on a public route.
import { revokeCreatorPublications } from "./publications.js";
import { creatorRepository } from "../repositories/creators.js";
import { permissionError } from "./authorization.js";
export function validateProvisioning(action, userId, value) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      userId || "",
    ) ||
    !["role", "status"].includes(action) ||
    !(
      action === "role"
        ? ["listener", "moderator", "admin"]
        : ["active", "inactive", "suspended"]
    ).includes(value)
  )
    throw permissionError(
      400,
      "INVALID_PROVISIONING",
      "Invalid operator action, account UUID or value.",
    );
}
export async function provisionIdentity(db, action, userId, value) {
  validateProvisioning(action, userId, value);
  return db.transaction(async () => {
    const repo = creatorRepository(db),
      account = await repo.account(userId, true);
    if (account?.kind !== "registered")
      throw permissionError(
        403,
        "REGISTERED_REQUIRED",
        "Only a registered account may be provisioned.",
      );
    if (action === "role")
      await db
        .prepare("UPDATE users SET platform_role=? WHERE id=?")
        .run(value, userId);
    else {
      if (!(await repo.profile(userId)))
        throw permissionError(
          404,
          "CREATOR_NOT_FOUND",
          "Creator profile not found.",
        );
      await repo.status(userId, value);
      if (value !== "active")
        await revokeCreatorPublications(db, userId, userId, "suspend");
    }
    return { action, value };
  });
}
