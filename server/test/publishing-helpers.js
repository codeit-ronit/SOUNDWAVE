import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, reserve } from "./private-media-helpers.js";
import { password } from "./phase2-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { processPrivateMedia } from "../media/private-processor.js";
import { provisionIdentity } from "../services/creator-operator.js";
import { RIGHTS_TERMS } from "../services/publications.js";
export async function publicationFixture(kind) {
  const f = await setup(kind, {
      processingSeconds: 5,
      derivativeMaxBytes: 262144,
    }),
    bytes = wav(16000),
    a = (await reserve(f, bytes)).body.asset;
  await f.c
    .write("put", `${f.path}/${a.id}/bytes`, bytes)
    .set("Content-Type", "audio/wav")
    .expect(200);
  const p = await f.db
    .prepare("SELECT id FROM private_processing_intents WHERE asset_id=?")
    .get(a.id);
  assert.equal((await processPrivateMedia(f.db, f.config, p.id)).ready, true);
  const moderator = await f.client();
  await moderator.auth("register", {
    email: `${randomUUID()}@example.com`,
    password,
    displayName: "Moderator",
  });
  await provisionIdentity(f.db, "role", moderator.data.user.id, "moderator");
  const base = `/creator/stories/${f.s.id}/publication`,
    review = `/moderation/stories/${f.s.id}`;
  const body = (expectedRevision, extra = {}) => ({
    expectedRevision,
    requestId: randomUUID(),
    ...extra,
  });
  const action = async (c, route, kind, extra = {}) => {
    const d = (await c.get(route).expect(200)).body;
    return c.write(
      "post",
      `${route}/${kind}`,
      body(d.publication?.revision ?? 0, extra),
    );
  };
  const submit = () =>
    action(f.c, base, "submit", { attest: true, termsVersion: RIGHTS_TERMS });
  const approve = () =>
    action(moderator, review, "approve", {
      code: "approved",
      note: "Reviewed exact content and media.",
    });
  const publish = () => action(f.c, base, "publish");
  return {
    ...f,
    a,
    moderator,
    base,
    review,
    body,
    action,
    submit,
    approve,
    publish,
  };
}
