import { AppErrorBoundary } from "./error-boundary";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./app";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
