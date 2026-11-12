import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTauri, isTauri } from "../src/tauri-bootstrap";
import { clearConnectionConfig, getCurrentConnectionConfig } from "../src/connection-config";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function stubWindow(invoke?: Invoke) {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    }
  };
  const win: {
    localStorage: typeof localStorage;
    __TAURI_INTERNALS__?: { invoke: Invoke };
    __MAILDECK_TAURI__?: { openExternal: (url: string) => Promise<{ opened: boolean }> };
  } = { localStorage };
  if (invoke) {
    win.__TAURI_INTERNALS__ = { invoke };
  }
  vi.stubGlobal("window", win);
  return { win, store };
}

describe("Tauri desktop bootstrap", () => {
  beforeEach(() => {
    stubWindow();
    clearConnectionConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing outside a Tauri WebView", async () => {
    expect(isTauri()).toBe(false);
    await expect(bootstrapTauri()).resolves.toBe(false);
    expect(getCurrentConnectionConfig()).toBeNull();
  });

  it("injects the sidecar connection config and exposes openExternal", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke: Invoke = async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_config") {
        return {
          serverUrl: "http://127.0.0.1:43210",
          apiToken: "one-time-token",
          version: "0.3.1"
        };
      }
      return true;
    };
    const { win } = stubWindow(invoke);

    await expect(bootstrapTauri()).resolves.toBe(true);
    expect(isTauri()).toBe(true);
    expect(getCurrentConnectionConfig()).toEqual({
      serverUrl: "http://127.0.0.1:43210",
      apiToken: "one-time-token"
    });

    await expect(win.__MAILDECK_TAURI__!.openExternal("https://example.com/x")).resolves.toEqual({
      opened: true
    });
    expect(calls).toEqual([
      ["desktop_config", undefined],
      ["open_external", { url: "https://example.com/x" }]
    ]);
  });

  it("retries while the sidecar health check is still running", async () => {
    let attempts = 0;
    const invoke: Invoke = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("not ready");
      }
      return { serverUrl: "http://127.0.0.1:43211", apiToken: "", version: "0.3.1" };
    };
    stubWindow(invoke);

    await expect(bootstrapTauri(5)).resolves.toBe(true);
    expect(attempts).toBe(3);
    expect(getCurrentConnectionConfig()?.serverUrl).toBe("http://127.0.0.1:43211");
  });

  it("surfaces a startup failure instead of hanging", async () => {
    const invoke: Invoke = async () => {
      throw new Error("sidecar exited");
    };
    stubWindow(invoke);

    await expect(bootstrapTauri(2)).rejects.toThrow("本地服务启动失败");
  });
});
