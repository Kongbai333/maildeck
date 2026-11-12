/// <reference types="vite/client" />

interface TauriDesktopHooks {
  openExternal(url: string): Promise<{ opened: boolean }>;
}

interface Window {
  __TAURI_INTERNALS__?: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  __MAILDECK_TAURI__?: TauriDesktopHooks;
}
