export const draftError = (status, code, message, current, chapter) =>
  Object.assign(Error(message), { status, draftCode: code, current, chapter });
export const invalidDraft = (message) =>
  draftError(400, "INVALID_DRAFT_REQUEST", message);
export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const revision = (value) => Number.isSafeInteger(value) && value >= 1;
export const draftId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,8}$/.test(value);
export function fields(body, keys) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !keys.includes(k))
  )
    throw invalidDraft("Provide only documented draft fields.");
}
function text(value, max, label, required = false, multiline = false) {
  if (
    typeof value !== "string" ||
    Array.from(value.trim()).length > max ||
    (required && !value.trim()) ||
    (multiline
      ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
      : /[\u0000-\u001f\u007f-\u009f]/
    ).test(value)
  )
    throw invalidDraft(
      `Invalid ${label}; maximum ${max} characters${required ? ", nonempty" : ""}.`,
    );
  return value.trim();
}
export function storyMetadata(body) {
  const title = text(body.title, 160, "title", true),
    description = text(body.description, 3000, "description", false, true),
    genre = text(body.genre, 60, "genre", true);
  if (
    typeof body.language !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.language)
  )
    throw invalidDraft(
      "language must be a 2/3-letter tag, optionally with an uppercase region.",
    );
  return { title, description, genre, language: body.language };
}
export function chapterMetadata(body) {
  return {
    title: text(body.title, 160, "chapter title", true),
    summary: text(body.summary, 2000, "chapter summary", false, true),
  };
}
export function draftPage(query, user) {
  if (Object.keys(query).some((k) => !["limit", "cursor"].includes(k)))
    throw invalidDraft("Only limit and cursor are supported.");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (
    (query.limit !== undefined &&
      (typeof query.limit !== "string" ||
        !/^([1-9]|[1-4]\d|50)$/.test(query.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw invalidDraft("limit must be 1–50.");
  let before;
  if (query.cursor !== undefined)
    try {
      if (
        typeof query.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,300}$/.test(query.cursor)
      )
        throw Error();
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw Error();
      const c = JSON.parse(bytes.toString());
      if (
        !c ||
        Object.keys(c).length !== 3 ||
        c.v !== 1 ||
        c.owner !== user ||
        !Number.isInteger(c.before) ||
        c.before < 1 ||
        c.before > 999999999
      )
        throw Error();
      before = c.before;
    } catch {
      throw invalidDraft("Invalid draft cursor.");
    }
  return { limit, before };
}
