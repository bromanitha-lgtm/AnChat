import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const monetagWorkerUrl = new URL("./sw.js", window.location.href).href;
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      Promise.all(
        registrations
          .filter((registration) =>
            [registration.active, registration.waiting, registration.installing].some(
              (worker) => worker?.scriptURL === monetagWorkerUrl,
            ),
          )
          .map((registration) => registration.unregister()),
      ),
    )
    .catch((error: unknown) => {
      console.error("Could not remove the previous Monetag service worker:", error);
    });
}
