export interface ConnectionConfig {
  /** 服务端根地址，例如 http://127.0.0.1:8787 或 https://mail.example.com。 */
  serverUrl: string;
  /** 可选的 MAILDECK_API_TOKEN。 */
  apiToken: string;
}

const STORAGE_KEY = "maildeck.connection.v1";
let currentConfig: ConnectionConfig | null | undefined;

function normalizeUrl(value: string) {
  let raw = value.trim();
  if (!raw) {
    return "";
  }
  if (!/^https?:\/\//iu.test(raw)) {
    raw = `http://${raw}`;
  }

  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("服务器地址只支持 HTTP 或 HTTPS");
  }
  if (parsed.pathname === "/api" || parsed.pathname === "/api/") {
    parsed.pathname = "/";
  }
  return parsed.toString().replace(/\/+$/u, "");
}

export function normalizeConnectionConfig(input: ConnectionConfig): ConnectionConfig {
  const serverUrl = normalizeUrl(input.serverUrl);
  if (!serverUrl) {
    throw new Error("请填写服务器地址");
  }
  return {
    serverUrl,
    apiToken: input.apiToken.trim()
  };
}

export function loadConnectionConfig(): ConnectionConfig | null {
  if (currentConfig !== undefined) {
    return currentConfig;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      currentConfig = null;
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (typeof parsed.serverUrl !== "string" || !parsed.serverUrl.trim()) {
      currentConfig = null;
      return null;
    }
    currentConfig = normalizeConnectionConfig({
      serverUrl: parsed.serverUrl,
      apiToken: typeof parsed.apiToken === "string" ? parsed.apiToken : ""
    });
    return currentConfig;
  } catch {
    currentConfig = null;
    return null;
  }
}

export function getCurrentConnectionConfig() {
  return currentConfig === undefined ? loadConnectionConfig() : currentConfig;
}

export function saveConnectionConfig(config: ConnectionConfig) {
  const normalized = normalizeConnectionConfig(config);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  currentConfig = normalized;
  return normalized;
}

export function clearConnectionConfig() {
  window.localStorage.removeItem(STORAGE_KEY);
  currentConfig = null;
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  const normalized = normalizeConnectionConfig(config);
  const headers = normalized.apiToken
    ? { Authorization: `Bearer ${normalized.apiToken}` }
    : undefined;

  let response: Response;
  try {
    response = await fetch(`${normalized.serverUrl}/api/health`, { headers });
  } catch (error) {
    throw new Error(`连不上服务器：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`服务器健康检查失败（HTTP ${response.status}）`);
  }

  const accounts = await fetch(`${normalized.serverUrl}/api/accounts`, { headers });
  if (accounts.status === 401) {
    throw new Error("密钥不正确，服务端拒绝了请求");
  }
  if (!accounts.ok) {
    throw new Error(`账号接口返回 HTTP ${accounts.status}`);
  }
}
