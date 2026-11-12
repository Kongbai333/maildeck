import { useEffect, useState } from "react";

export const ROUTES = {
  login: "/login",
  adminOverview: "/admin/overview",
  adminMailboxes: "/admin/mailboxes",
  adminUsers: "/admin/users",
  adminProviders: "/admin/providers",
  mailbox: "/mailbox",
  /** 在线播放（需管理员或被授权的账号） */
  onlinePlay: "/online-play",
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/**
 * 已下线的旧路由 → 现路由映射。
 * 「统计」页已并入「概览」，老链接 #/admin/stats 统一重定向到 #/admin/overview，避免 404。
 */
export const LEGACY_ROUTE_REDIRECTS: Readonly<Record<string, string>> = {
  "/admin/stats": ROUTES.adminOverview,
};

const KNOWN_ROUTES: readonly string[] = Object.values(ROUTES);

export function isKnownRoute(path: string): boolean {
  return KNOWN_ROUTES.includes(path);
}

/** 读取当前 hash 路由，统一成 "/xxx" 形式；空 hash 返回 "/" */
export function readRoute(): string {
  const raw = window.location.hash.replace(/^#/, "");
  if (raw === "") return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function navigate(path: string, replace = false): void {
  const target = `#${path}`;
  if (window.location.hash === target) return;
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
    // replaceState 不触发 hashchange，手动派发一次
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = path;
}

export function useRoute(): string {
  const [route, setRoute] = useState<string>(() => readRoute());

  useEffect(() => {
    const onChange = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}
