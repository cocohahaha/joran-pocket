import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "@xterm/xterm/css/xterm.css";

// Deliberately NOT auto-reloading on SW controllerchange — during a
// connect attempt, the reload destroys the in-flight WebSocket/RTCPC and
// loops forever. Users can manually refresh after a deploy if needed.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
