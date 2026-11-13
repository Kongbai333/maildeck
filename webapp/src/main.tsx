import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import "./styles.css";
import "./styles/workspace.css";
import "./styles/viewport.css";
import { applyTheme, readThemeMode } from "./theme";

// 首帧前同步主题，避免深浅色闪烁
applyTheme(readThemeMode());

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载节点");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
