import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-ext-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-ext-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-ext-600.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-ext-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-ext-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-ext-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-ext-600.css";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StoreProvider } from "./store";
import { ThemeProvider } from "./components/theme";
import { deepLinkHash } from "./terminalRoute";

// The deep link from Pushover notifications has PATH form (`/sessions?terminal=<id>`) —
// HashRouter does not see a query outside the hash, so the link would end up on Overview.
// The translation to the terminal hash address MUST happen before the router mounts.
const deepLink = deepLinkHash(window.location.search);
if (deepLink) window.location.replace(deepLink);

// The outer boundary is the last resort: a crash outside `<main>` (menu, store, vault)
// would otherwise unmount the whole tree again and leave an empty `#root`. Inside App there is
// a per-page boundary of its own, so the menu survives an ordinary error.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary where="root">
      <ThemeProvider>
        <HashRouter>
          <StoreProvider>
            <App />
          </StoreProvider>
        </HashRouter>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
