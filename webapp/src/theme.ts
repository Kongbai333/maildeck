import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "maildeck.theme";

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* localStorage 不可用时退回跟随系统 */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** 把 <html data-theme> 与 color-scheme 同步到当前模式。 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 忽略写入失败 */
  }
}

export interface ThemeController {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

/** 主题切换：本地持久化，跟随系统时监听系统配色变化。 */
export function useThemeMode(): ThemeController {
  const [mode, setModeState] = useState<ThemeMode>(() => readThemeMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemeMode()));

  useEffect(() => {
    applyTheme(mode);
    setResolved(resolveTheme(mode));
    if (mode !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode): void => {
    writeThemeMode(next);
    setModeState(next);
  }, []);

  return { mode, resolved, setMode };
}
