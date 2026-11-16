export const progressFailure = (status, code, message, progress) =>
  Object.assign(new Error(message), {
    status,
    code,
    progress,
    progressFailure: true,
  });
