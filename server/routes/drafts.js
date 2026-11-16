import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { draftService } from "../services/drafts.js";
import {
  fields,
  storyMetadata,
  chapterMetadata,
  revision,
  uuid,
  draftId,
  draftPage,
  invalidDraft,
} from "../services/draft-contract.js";
export function draftRouter(db) {
  const router = Router(),
    service = draftService(db);
  router.use(requireUser, (req, _res, next) => {
    if (req.method !== "GET" && Object.keys(req.query).length)
      return next(invalidDraft("No mutation query parameters accepted."));
    next();
  });
  router.param("id", (req, _res, next, value) =>
    draftId(value) ? next() : next(invalidDraft("Invalid story ID.")),
  );
  router.param("chapter", (req, _res, next, value) =>
    draftId(value) ? next() : next(invalidDraft("Invalid chapter ID.")),
  );
  const precondition = (body, key = "expectedRevision") => {
    if (body[key] === undefined)
      throw Object.assign(invalidDraft(`${key} is required.`), {
        status: 428,
        draftCode: "DRAFT_PRECONDITION_REQUIRED",
      });
    if (!revision(body[key]))
      throw invalidDraft(`${key} must be a positive safe integer.`);
    return body[key];
  };
  const creation = (body) => {
    if (!uuid(body.requestId))
      throw invalidDraft("A UUID requestId is required.");
    return body.requestId;
  };
  router.get("/", async (req, res) => {
    const { limit, before } = draftPage(req.query, req.user.id);
    res.json(await service.list(req.user, limit, before));
  });
  router.post("/", async (req, res) => {
    fields(req.body, [
      "title",
      "description",
      "genre",
      "language",
      "requestId",
    ]);
    const data = await service.create(
      req.user,
      storyMetadata(req.body),
      creation(req.body),
    );
    res.status(data.replayed ? 200 : 201).json(data);
  });
  router.get("/:id", async (req, res) => {
    if (Object.keys(req.query).length)
      throw invalidDraft("No read selectors accepted.");
    res.json(await service.read(req.user, Number(req.params.id)));
  });
  router.put("/:id", async (req, res) => {
    fields(req.body, [
      "title",
      "description",
      "genre",
      "language",
      "expectedRevision",
    ]);
    res.json(
      await service.edit(
        req.user,
        Number(req.params.id),
        storyMetadata(req.body),
        precondition(req.body),
      ),
    );
  });
  router.post("/:id/archive", async (req, res) => {
    fields(req.body, ["expectedRevision"]);
    res.json(
      await service.archive(
        req.user,
        Number(req.params.id),
        precondition(req.body),
      ),
    );
  });
  router.post("/:id/chapters", async (req, res) => {
    fields(req.body, [
      "title",
      "summary",
      "requestId",
      "expectedStoryRevision",
    ]);
    const data = await service.addChapter(
      req.user,
      Number(req.params.id),
      chapterMetadata(req.body),
      creation(req.body),
      precondition(req.body, "expectedStoryRevision"),
    );
    res.status(data.replayed ? 200 : 201).json(data);
  });
  router.put("/:id/chapters/order", async (req, res) => {
    fields(req.body, ["chapterIds", "expectedRevision"]);
    const ids = req.body.chapterIds;
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => !Number.isInteger(id) || id < 1 || id > 999999999)
    )
      throw invalidDraft(
        "chapterIds must contain at most 100 numeric chapter IDs.",
      );
    res.json(
      await service.reorder(
        req.user,
        Number(req.params.id),
        ids,
        precondition(req.body),
      ),
    );
  });
  router.get("/:id/chapters/:chapter", async (req, res) => {
    if (Object.keys(req.query).length)
      throw invalidDraft("No read selectors accepted.");
    res.json(
      await service.readChapter(
        req.user,
        Number(req.params.id),
        Number(req.params.chapter),
      ),
    );
  });
  router.put("/:id/chapters/:chapter", async (req, res) => {
    fields(req.body, ["title", "summary", "expectedRevision"]);
    res.json(
      await service.editChapter(
        req.user,
        Number(req.params.id),
        Number(req.params.chapter),
        chapterMetadata(req.body),
        precondition(req.body),
      ),
    );
  });
  router.delete("/:id/chapters/:chapter", async (req, res) => {
    fields(req.body, ["expectedRevision", "expectedStoryRevision"]);
    res.json(
      await service.removeChapter(
        req.user,
        Number(req.params.id),
        Number(req.params.chapter),
        precondition(req.body),
        precondition(req.body, "expectedStoryRevision"),
      ),
    );
  });
  router.use((error, _req, res, next) => {
    const code = error.draftCode || error.permissionCode;
    if (!code) return next(error);
    res.status(error.status).json({
      error: { code, message: error.message },
      ...(error.current ? { current: error.current } : {}),
      ...(error.chapter ? { chapter: error.chapter } : {}),
    });
  });
  return router;
}
