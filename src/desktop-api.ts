import type { MailDeckApi } from "../electron/preload/index.cjs";
import { getCurrentConnectionConfig } from "./connection-config";
import { createHttpMailDeckApi } from "./http-maildeck-api";

export function getDesktopApi(): MailDeckApi | undefined {
  const env = import.meta.env as Record<string, unknown>;
  const forceHttp = env.VITE_FORCE_HTTP_API === "1";

  if (!forceHttp && typeof window !== "undefined") {
    const native = (window as Window & { maildeck?: MailDeckApi }).maildeck;
    if (native) {
      return native;
    }
  }

  // Vitest/jsdom 没有 Electron bridge，但仍应走“缺少桌面桥”的分支；真实浏览器
  // 与 Capacitor 环境默认走 HTTP API。
  if (env.MODE === "test") {
    return undefined;
  }
  const config = getCurrentConnectionConfig();
  if (!config) {
    return undefined;
  }
  return createHttpMailDeckApi(config);
}
