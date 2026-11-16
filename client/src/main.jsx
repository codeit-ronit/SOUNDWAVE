import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PlayerProvider } from "./PlayerContext";
import { LibraryProvider } from "./LibraryContext";
import { OfflineProvider } from "./OfflineContext";
import App from "./App";
import { AuthProvider } from "./AuthContext";
import { PreferencesProvider } from "./PreferencesContext";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {(session) => (
          <OfflineProvider key={session.csrfToken || "offline"}>
            <PreferencesProvider session={session}>
              <PlayerProvider session={session}>
                <LibraryProvider session={session}>
                  <App />
                </LibraryProvider>
              </PlayerProvider>
            </PreferencesProvider>
          </OfflineProvider>
        )}
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
