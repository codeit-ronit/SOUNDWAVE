import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadPrivateAudio } from "./api";
let last;
class Xhr {
  constructor() {
    last = this;
    this.upload = {};
    this.headers = {};
  }
  open(method, path) {
    this.method = method;
    this.path = path;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send(body) {
    this.body = body;
  }
  abort() {
    this.onabort();
  }
}
beforeEach(() => vi.stubGlobal("XMLHttpRequest", Xhr));
afterEach(() => vi.unstubAllGlobals());
it("sends raw file bytes with captured session/CSRF headers and actual transfer progress", async () => {
  const progress = vi.fn(),
    file = new Blob(["audio"]);
  const promise = uploadPrivateAudio(1, 2, "asset", file, {
    session: { user: { id: "owner" }, csrfToken: "token" },
    onProgress: progress,
  });
  expect(last.method).toBe("PUT");
  expect(last.path).toBe("/api/creator/stories/1/chapters/2/media/asset/bytes");
  expect(last.body).toBe(file);
  expect(last.headers).toEqual({
    "Content-Type": "audio/wav",
    "X-CSRF-Token": "token",
    "X-Session-User": "owner",
  });
  last.upload.onprogress({ lengthComputable: true, loaded: 2, total: 5 });
  expect(progress).toHaveBeenCalledWith(40);
  last.status = 200;
  last.responseText = '{"asset":{"status":"validated"}}';
  last.onload();
  expect((await promise).asset.status).toBe("validated");
});
it("propagates structured validation errors and aborts the underlying transfer", async () => {
  const promise = uploadPrivateAudio(1, 2, "asset", new Blob(["bad"]));
  last.status = 422;
  last.responseText =
    '{"error":{"code":"INVALID_AUDIO","message":"Invalid PCM"}}';
  last.onload();
  await expect(promise).rejects.toMatchObject({
    status: 422,
    code: "INVALID_AUDIO",
  });
  const controller = new AbortController();
  const pending = uploadPrivateAudio(1, 2, "asset", new Blob(["audio"]), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
