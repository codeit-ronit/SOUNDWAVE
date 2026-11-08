import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import {
  historyService,
  historyPagination,
  invalidHistory,
} from "../services/history.js";
const revision = (n) => Number.isSafeInteger(n) && n >= 0;
function body(req, keys) {
  if (
    Object.keys(req.query).length ||
    !req.body ||
    Array.isArray(req.body) ||
    typeof req.body !== "object" ||
    Object.keys(req.body).some((k) => !keys.includes(k))
  )
    throw invalidHistory("Provide only the documented history fields.");
}
export function historyRouter(db) {
  const router = Router(),
    service = historyService(db);
  router.use(requireUser);
  router.get("/", async (req, res) => {
    const p = historyPagination(req.query, req.user.id);
    res.json(await service.list(req.user.id, p.limit, p.cursor));
  });
  router.delete("/", async (req, res) => {
    body(req, ["expectedHistoryRevision", "confirm"]);
    if (
      !revision(req.body.expectedHistoryRevision) ||
      req.body.confirm !== "CLEAR_SAVED_HISTORY"
    )
      throw invalidHistory(
        "Confirm CLEAR_SAVED_HISTORY with the displayed history revision.",
      );
    res.json(
      await service.clear(req.user.id, req.body.expectedHistoryRevision),
    );
  });
  router.delete("/:chapterId", async (req, res) => {
    if (!/^[1-9]\d{0,8}$/.test(req.params.chapterId))
      throw invalidHistory("Invalid chapter ID.");
    body(req, ["expectedRevision"]);
    if (!revision(req.body.expectedRevision))
      throw invalidHistory(
        "expectedRevision is required and must be a nonnegative safe integer.",
      );
    res.json(
      await service.remove(
        req.user.id,
        Number(req.params.chapterId),
        req.body.expectedRevision,
      ),
    );
  });
  router.use((error, _req, res, next) => {
    if (!error.progressFailure) return next(error);
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
      ...(error.progress ? { progress: error.progress } : {}),
      ...(error.historyRevision !== undefined
        ? { historyRevision: error.historyRevision }
        : {}),
    });
  });
  return router;
}
