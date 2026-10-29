import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { request } from "./api";
export default function AccountRecovery() {
  const route = useLocation();
  const readLink = () => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const reset = params.get("reset_password"),
      verify = params.get("verify_email");

    return {
      token: reset || verify,
      mode: reset
        ? "reset-password"
        : verify
          ? "verify-email"
          : "forgot-password",
    };
  };
  const [link, setLink] = useState(readLink);
  useEffect(() => {
    const consume = () => {
      const next = readLink();
      if (!next.token) return;
      setLink(next);
      setMessage("");
      setError("");
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, [route.hash]);
  const [message, setMessage] = useState(
      new URLSearchParams(location.search).get("reset") === "success"
        ? "Password reset. Your previous sessions were revoked. Sign in with your new password."
        : "",
    ),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await request("/auth/" + link.mode, {
        method: "POST",
        body: JSON.stringify(
          link.token ? { token: link.token, ...values } : values,
        ),
      });
      if (link.mode === "reset-password") {
        window.location.replace("/account?reset=success");
        return;
      }
      setMessage(result.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const title =
    link.mode === "reset-password"
      ? "Choose a new password"
      : link.mode === "verify-email"
        ? "Verify your email"
        : "Recover your account";
  return (
    <section className="account-recovery">
      <span className="eyebrow">YOUR SOUNDWAVE ACCOUNT</span>
      <h1>{title}</h1>
      {message ? (
        <>
          <p role="status">{message}</p>
          <a className="button primary" href="/?signin=1">
            Return to sign in
          </a>
        </>
      ) : (
        <form onSubmit={submit}>
          {link.mode === "forgot-password" && (
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
          )}
          {link.mode === "reset-password" && (
            <label>
              New password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
              />
            </label>
          )}
          {link.mode === "verify-email" && (
            <p>Confirm your email address using this one-time link.</p>
          )}
          <button type="submit" className="button primary" disabled={pending}>
            {pending
              ? "Please wait…"
              : link.mode === "reset-password"
                ? "Reset password"
                : link.mode === "verify-email"
                  ? "Verify email"
                  : "Send reset link"}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <Link to="/">Back to stories</Link>
    </section>
  );
}
