import type { MailDeckApi } from "../electron/preload/index.cjs";
import type { ConnectionConfig } from "./connection-config";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  AppErrorPayload,
  AppSettings,
  AppSettingsUpdate,
  DeviceCodeSessionView,
  DeviceCodeStateEvent,
  GetMessageOptions,
  ImportResult,
  ListAttachmentsOptions,
  ListMessagesOptions,
  MailAttachmentListResult,
  MailCacheStats,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  RefreshManyResult,
  RefreshJobKind,
  SaveAttachmentOptions,
  SaveAttachmentResult,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult,
  UpdateStateEvent
} from "../electron/shared/ipc-contracts";

let activeConfig: ConnectionConfig = { serverUrl: "", apiToken: "" };

function apiBaseUrl() {
  const base = activeConfig.serverUrl.trim().replace(/\/+$/u, "");
  return base ? `${base}/api` : "/api";
}

function apiToken() {
  return activeConfig.apiToken.trim();
}

function requestHeaders(init: RequestInit) {
  const headers = new Headers(init.headers);
  const token = apiToken();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

function throwApiError(payload: AppErrorPayload): never {
  const error = Object.assign(new Error(payload.message), {
    code: payload.code,
    retryable: payload.retryable,
    ...(payload.diagnostic ? { diagnostic: payload.diagnostic } : {})
  });
  throw error;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = requestHeaders(init);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers
    });
  } catch (error) {
    throwApiError({
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : "连接服务端失败",
      retryable: true
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  const envelope = payload as { ok?: boolean; value?: T; error?: AppErrorPayload } | null;
  if (!response.ok || !envelope || envelope.ok !== true) {
    if (envelope?.error) {
      throwApiError(envelope.error);
    }
    throwApiError({
      code: "UNKNOWN",
      message: `服务端请求失败（HTTP ${response.status}）`,
      retryable: response.status >= 500
    });
  }

  return envelope.value as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(value)
  };
}

function pickTextFile(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.csv,text/plain,text/csv";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve, reject);
    };
    input.click();
  });
}

function downloadBlob(blob: Blob, fileName: string): SaveAttachmentResult {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { saved: true, canceled: false, path: fileName };
}

function extensionFromType(contentType: string) {
  if (contentType.includes("pdf")) return "pdf";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("zip")) return "zip";
  return "bin";
}

let httpApiInstance: MailDeckApi | null = null;
let httpApiKey = "";

export function createHttpMailDeckApi(config: ConnectionConfig): MailDeckApi {
  const nextKey = `${config.serverUrl}\n${config.apiToken}`;
  if (httpApiInstance && httpApiKey === nextKey) {
    return httpApiInstance;
  }

  activeConfig = config;
  httpApiKey = nextKey;
  const api = {
    app: {
      openExternal: async (url: string) => {
        // Tauri WebView 里 window.open 会被拦；桌面壳改为走 open_external 命令。
        const hooks = typeof window === "undefined"
          ? undefined
          : (window as Window & {
              __MAILDECK_TAURI__?: { openExternal: (url: string) => Promise<{ opened: boolean }> };
            }).__MAILDECK_TAURI__;
        if (hooks) {
          return hooks.openExternal(url);
        }
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (!opened) {
          throwApiError({
            code: "NETWORK_ERROR",
            message: "浏览器拦截了新窗口，请允许弹出窗口后重试",
            retryable: true
          });
        }
        return { opened: true };
      }
    },
    accounts: {
      list: () => request<AccountView[]>("/accounts"),
      previewImportText: (text: string) =>
        request<Awaited<ReturnType<MailDeckApi["accounts"]["previewImportText"]>>>("/accounts/preview", jsonBody({ text })),
      importText: (text: string) =>
        request<ImportResult>("/accounts/import", jsonBody({ text })),
      importFile: async () => {
        const text = await pickTextFile();
        if (text === null) {
          return null;
        }
        return request<ImportResult>("/accounts/import", jsonBody({ text }));
      },
      upsert: (input: AccountInput) =>
        request<ImportResult>("/accounts", jsonBody({ input })),
      update: (input: AccountUpdateInput) =>
        request<Awaited<ReturnType<MailDeckApi["accounts"]["update"]>>>(
          `/accounts/${encodeURIComponent(input.id)}`,
          { method: "PATCH", body: JSON.stringify(input) }
        ),
      delete: (accountId: string) =>
        request<Awaited<ReturnType<MailDeckApi["accounts"]["delete"]>>>(
          `/accounts/${encodeURIComponent(accountId)}`,
          { method: "DELETE" }
        ),
      test: (accountId: string) =>
        request<TestConnectionResult>(`/accounts/${encodeURIComponent(accountId)}/test`, { method: "POST" }),
      testFallback: (accountId: string) =>
        request<TestFallbackResult>(`/accounts/${encodeURIComponent(accountId)}/test-fallback`, { method: "POST" }),
      testMany: (accountIds: string[]) =>
        request<TestManyResult[]>("/accounts/test-many", jsonBody({ accountIds })),
      refreshMany: (accountIds: string[], jobKind?: RefreshJobKind) =>
        request<RefreshManyResult[]>("/accounts/refresh-many", jsonBody({ accountIds, jobKind })),
      onRefreshProgress: () => () => undefined,
      onTestProgress: () => () => undefined
    },
    mail: {
      listFolders: (accountId: string) =>
        request<MailFolder[]>(`/mail/folders?accountId=${encodeURIComponent(accountId)}`),
      listMessages: (options: ListMessagesOptions) =>
        request<MailListResult>("/mail/list", jsonBody(options)),
      getMessage: (options: GetMessageOptions) =>
        request<MailMessageDetail>("/mail/message", jsonBody(options)),
      listAttachments: (options: ListAttachmentsOptions) =>
        request<MailAttachmentListResult>("/mail/attachments", jsonBody(options)),
      saveAttachment: async (options: SaveAttachmentOptions) => {
        const query = new URLSearchParams({
          accountId: options.accountId,
          messageId: options.messageId,
          attachmentId: options.attachmentId
        });
        const response = await fetch(`${apiBaseUrl()}/mail/attachment?${query.toString()}`, {
          headers: requestHeaders({})
        });
        if (!response.ok) {
          throwApiError({
            code: "NETWORK_ERROR",
            message: `附件下载失败（HTTP ${response.status}）`,
            retryable: response.status >= 500
          });
        }
        const blob = await response.blob();
        const header = response.headers.get("content-disposition") || "";
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
        const name = encoded ? decodeURIComponent(encoded) : `attachment-${options.attachmentId}.${extensionFromType(blob.type)}`;
        return downloadBlob(blob, name);
      },
      cacheStats: () => request<MailCacheStats>("/mail/cache-stats"),
      clearCache: (accountId?: string) =>
        request<{ cleared: number | "all" }>(
          `/mail/cache${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`,
          { method: "DELETE" }
        )
    },
    settings: {
      get: () => request<AppSettings>("/settings"),
      update: (settings: AppSettingsUpdate) =>
        request<AppSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) })
    },
    jobs: {
      cancel: (kind: "test" | RefreshJobKind) =>
        request<{ canceled: typeof kind; count: number }>("/jobs/cancel", jsonBody({ kind }))
    },
    auth: {
      startDeviceCode: (options?: { clientId?: string }) =>
        request<DeviceCodeSessionView>(
          "/auth/device-code/start",
          jsonBody({ clientId: options?.clientId })
        ),
      cancelDeviceCode: () =>
        request<{ canceled: boolean }>("/auth/device-code/cancel", { method: "POST" }),
      onDeviceCodeState: (callback: (event: DeviceCodeStateEvent) => void) => {
        let stopped = false;
        const timer = window.setInterval(() => {
          if (stopped) {
            return;
          }
          request<DeviceCodeStateEvent>("/auth/device-code/state")
            .then((event) => {
              if (stopped) {
                return;
              }
              callback(event);
              if (event.phase === "authorized" || event.phase === "failed") {
                stopped = true;
                window.clearInterval(timer);
              }
            })
            .catch(() => undefined);
        }, 1_000);
        return () => {
          stopped = true;
          window.clearInterval(timer);
        };
      }
    },
    update: {
      getState: async (): Promise<UpdateStateEvent> => ({ phase: "idle" }),
      check: async (): Promise<UpdateStateEvent> => ({
        phase: "not-available",
        version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"
      }),
      install: async () => ({
        started: false,
        state: { phase: "unsupported", reason: "portable" as const }
      }),
      onState: (_callback: (event: UpdateStateEvent) => void) => () => undefined
    }
  };

  httpApiInstance = api as unknown as MailDeckApi;
  return httpApiInstance;
}
