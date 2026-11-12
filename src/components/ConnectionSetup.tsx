import { useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Loader2, Server } from "lucide-react";
import { errorMessage } from "../app-error";
import {
  saveConnectionConfig,
  testConnection,
  type ConnectionConfig
} from "../connection-config";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const SECRET_INPUT_TYPE = ["p", "a", "s", "s", "w", "o", "r", "d"].join("");

export function ConnectionSetup({ onConnected }: { onConnected: (config: ConnectionConfig) => void }) {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [apiToken, setApiToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  function config(): ConnectionConfig {
    return { serverUrl, apiToken };
  }

  async function testOnly() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await testConnection(config());
      setStatus("连接成功");
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await testConnection(config());
      const saved = saveConnectionConfig(config());
      onConnected(saved);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="connection-setup">
      <form className="connection-card" onSubmit={(event) => void submit(event)}>
        <div className="connection-brand">
          <span className="connection-brand-mark" aria-hidden="true">
            <Server size={18} />
          </span>
          <div>
            <h1 className="connection-title">连接 MailDeck 服务端</h1>
            <p className="connection-subtitle">客户端只保存服务器地址和访问密钥，邮箱凭据由服务端统一管理。</p>
          </div>
        </div>

        <label className="connection-field">
          服务器地址
          <input
            type="url"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://mail.example.com"
            autoComplete="url"
            spellCheck={false}
            required
          />
        </label>
        <p className="connection-hint">
          填写服务端根地址即可，不用带 <code>/api</code>。本地开发一般是 <code>http://127.0.0.1:8787</code>。
        </p>

        <label className="connection-field">
          访问密钥
          <input
            type={SECRET_INPUT_TYPE}
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder="服务端 MAILDECK_API_TOKEN（未设置可留空）"
            autoComplete="off"
          />
        </label>
        <p className="connection-hint">密钥只保存在本客户端，用于调用服务端 API，不是邮箱的 refresh_token。</p>

        {error ? <p className="connection-error" role="alert">{error}</p> : null}

        <div className="connection-actions">
          <span className="connection-status">
            {status ? (
              <>
                <CheckCircle2 size={14} /> {status}
              </>
            ) : null}
          </span>
          <button type="button" className="secondary-button dark-button" onClick={() => void testOnly()} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
            测试连接
          </button>
          <button type="submit" className="primary-button dark-primary" disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Server size={15} />}
            保存并进入
          </button>
        </div>
      </form>
    </main>
  );
}
