import { saveConnectionConfig } from "./connection-config";

export interface TauriDesktopConfig {
  serverUrl: string;
  apiToken: string;
  version: string;
}

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

/**
 * Tauri 桌面壳启动引导：从 Rust 侧取回本次启动的 sidecar 地址与一次性 token，
 * 写进连接配置后复用现有 HTTP API；渲染层因此不需要任何 Tauri 专属分支。
 *
 * setup 阶段 sidecar 可能还在健康检查中，`desktop_config` 会短暂失败，
 * 这里按 200 ms × maxAttempts 重试；失败则把原因显示出来而不是停在空白页。
 */
export async function bootstrapTauri(maxAttempts = 20): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }

  const internals = window.__TAURI_INTERNALS__!;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const config = await internals.invoke<TauriDesktopConfig>("desktop_config");
      if (!config || typeof config.serverUrl !== "string" || config.serverUrl.length === 0) {
        throw new Error("Tauri 桌面服务尚未就绪");
      }

      saveConnectionConfig({
        serverUrl: config.serverUrl,
        apiToken: typeof config.apiToken === "string" ? config.apiToken : ""
      });

      window.__MAILDECK_TAURI__ = {
        openExternal: async (url: string) => {
          const opened = await internals.invoke<boolean>("open_external", { url });
          return { opened };
        }
      };
      return true;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`本地服务启动失败：${reason}`);
}
