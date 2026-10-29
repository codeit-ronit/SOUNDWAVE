import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PlayerProvider } from "./PlayerContext";
import { LibraryProvider } from "./LibraryContext";
import { OfflineProvider } from "./OfflineContext";
import App from "./App";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <OfflineProvider>
        <PlayerProvider>
          <LibraryProvider>
            <App />
          </LibraryProvider>
        </PlayerProvider>
      </OfflineProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
