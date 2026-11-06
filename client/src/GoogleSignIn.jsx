import { useEffect, useRef, useState } from "react";
import { request } from "./api";

let scriptPromise;
export function loadGoogleIdentity() {
  if (window.google?.accounts?.id)
    return Promise.resolve(window.google.accounts.id);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => failed(), 15000);
    function failed() {
      clearTimeout(timer);
      script.remove();
      scriptPromise = null;
      reject(
        Error(
          "Google sign-in could not load. Check your connection and retry.",
        ),
      );
    }
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      clearTimeout(timer);
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
      else failed();
    };
    script.onerror = failed;
    document.head.appendChild(script);
  });
  return scriptPromise;
}
export default function GoogleSignIn({ auth, onSuccess }) {
  const container = useRef(null),
    challenge = useRef(null),
    busy = useRef(false);
  const [attempt, setAttempt] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [signing, setSigning] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    // Reuse the request across StrictMode's setup/cleanup cycle. Two challenges
    // racing to replace each other would otherwise invalidate the rendered nonce.
    challenge.current ||= request("/auth/google/challenge", {
      method: "POST",
      body: "{}",
    });
    Promise.all([loadGoogleIdentity(), challenge.current])
      .then(([google, config]) => {
        if (!live) return;
        container.current.replaceChildren();
        google.initialize({
          client_id: config.clientId,
          nonce: config.nonce,
          auto_select: false,
          use_fedcm_for_button: true,
          callback: async (response) => {
            if (!live || busy.current) return;
            busy.current = true;
            setSigning(true);
            setError("");
            try {
              await auth.change("google", { credential: response.credential });
              if (live) onSuccess();
            } catch (e) {
              if (live) setError(e.message);
            } finally {
              busy.current = false;
              if (live) setSigning(false);
            }
          },
        });
        google.renderButton(container.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          width: Math.min(288, container.current.clientWidth || 288),
        });
        setLoading(false);
      })
      .catch((e) => {
        if (live) {
          setLoading(false);
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  return (
    <div className="google-sign-in">
      <div
        ref={container}
        aria-label="Google sign-in"
        hidden={!!error || signing}
      />
      {(loading || signing) && (
        <p role="status">
          {signing ? "Signing in with Google…" : "Loading Google sign-in…"}
        </p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={signing}
            onClick={() => {
              challenge.current = null;
              setAttempt((n) => n + 1);
            }}
          >
            Try Google again
          </button>
        </>
      )}
    </div>
  );
}
