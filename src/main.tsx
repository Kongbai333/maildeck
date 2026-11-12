import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConnectionSetup } from "./components/ConnectionSetup";
import { loadConnectionConfig, type ConnectionConfig } from "./connection-config";
import { bootstrapTauri, isTauri } from "./tauri-bootstrap";
import "./styles.css";

function hasNativeBridge() {
  return typeof window !== "undefined" && Boolean(window.maildeck);
}

function forceHttpMode() {
  const env = import.meta.env as Record<string, unknown>;
  return env.VITE_FORCE_HTTP_API === "1";
}

function Bootstrap() {
  const tauriMode = isTauri();
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [tauriPending, setTauriPending] = useState(tauriMode);
  const [tauriError, setTauriError] = useState<string | null>(null);

  useEffect(() => {
    if (tauriMode) {
      void bootstrapTauri().then(
        () => {
          setConnection(loadConnectionConfig());
          setTauriPending(false);
          setReady(true);
        },
        (error: unknown) => {
          setTauriError(error instanceof Error ? error.message : String(error));
        }
      );
      return;
    }
    if (hasNativeBridge() && !forceHttpMode()) {
      setReady(true);
      return;
    }
    setConnection(loadConnectionConfig());
    setReady(true);
  }, [tauriMode]);

  if (tauriError) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: 32, color: "#b42318" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>MailDeck</h1>
        <p>{tauriError}</p>
      </div>
    );
  }

  if (tauriPending) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: 32, color: "#475467" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>MailDeck</h1>
        <p>正在启动本地服务…</p>
      </div>
    );
  }

  if (!ready) {
    return null;
  }

  if (hasNativeBridge() && !forceHttpMode()) {
    return <App />;
  }

  if (!connection) {
    return <ConnectionSetup onConnected={setConnection} />;
  }

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>
);
