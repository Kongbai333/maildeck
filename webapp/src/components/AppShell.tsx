import {
  ChevronRight, Inbox, KeyRound, LayoutDashboard, LogOut, Mail, Menu,
  Monitor, Moon, Play, Server, Sun, Users, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ROUTES } from "../router";
import type { ThemeMode } from "../theme";
import { THEME_MODE_LABEL, useThemeMode } from "../theme";
import type { Role, SessionUser } from "../types";
import { cx, ROLE_LABEL } from "../utils";
import { ChangePasswordModal } from "./ChangePasswordModal";

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  roles: Role[];
  group: "管理空间" | "个人空间";
  needsOnlinePlay?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: ROUTES.adminOverview, label: "工作台概览", icon: <LayoutDashboard size={18} />, roles: ["admin"], group: "管理空间" },
  { path: ROUTES.adminMailboxes, label: "邮箱池", icon: <Inbox size={18} />, roles: ["admin"], group: "管理空间" },
  { path: ROUTES.adminUsers, label: "用户管理", icon: <Users size={18} />, roles: ["admin"], group: "管理空间" },
  { path: ROUTES.adminProviders, label: "服务商管理", icon: <Server size={18} />, roles: ["admin"], group: "管理空间" },
  { path: ROUTES.mailbox, label: "我的邮箱", icon: <Mail size={18} />, roles: ["admin", "user"], group: "个人空间" },
  { path: ROUTES.onlinePlay, label: "在线播放", icon: <Play size={18} />, roles: ["admin", "user"], group: "个人空间", needsOnlinePlay: true },
];

const PAGE_META: Record<string, { title: string; subtitle: string; eyebrow: string }> = {
  [ROUTES.adminOverview]: { title: "工作台概览", subtitle: "让每一封来信，都井井有条。", eyebrow: "WORKSPACE / OVERVIEW" },
  [ROUTES.adminMailboxes]: { title: "邮箱池", subtitle: "统一管理邮箱资源，轻松完成导入、分配与维护。", eyebrow: "MANAGE / MAILBOXES" },
  [ROUTES.adminUsers]: { title: "用户管理", subtitle: "管理成员、访问权限与各类邮箱配额。", eyebrow: "MANAGE / MEMBERS" },
  [ROUTES.adminProviders]: { title: "服务商管理", subtitle: "连接邮件服务，管理接入配置与可用域名。", eyebrow: "MANAGE / PROVIDERS" },
  [ROUTES.mailbox]: { title: "我的邮箱", subtitle: "所有收件箱，一处专注处理。", eyebrow: "PERSONAL / INBOX" },
  [ROUTES.onlinePlay]: { title: "在线播放", subtitle: "发现频道，随时开启你的观看时刻。", eyebrow: "PERSONAL / CHANNELS" },
};

export interface AppShellProps {
  user: SessionUser;
  route: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function AppShell({ user, route, onNavigate, onSignOut, children }: AppShellProps): ReactNode {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const theme = useThemeMode();
  const themeIcon = theme.mode === "light" ? <Sun size={17} /> : theme.mode === "dark" ? <Moon size={17} /> : <Monitor size={17} />;
  const cycleTheme = (): void => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    theme.setMode(order[(order.indexOf(theme.mode) + 1) % order.length]);
  };
  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role) &&
    (!item.needsOnlinePlay || user.role === "admin" || user.canOnlinePlay === true));
  const singleMenu = items.length <= 1;
  const meta = PAGE_META[route] ?? { title: "MailDeck", subtitle: "你的邮箱工作空间", eyebrow: "WORKSPACE" };
  const group = items.find((item) => item.path === route)?.group ?? "个人空间";

  useEffect(() => { setDrawerOpen(false); }, [route]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const menuButton = menuRef.current;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLButtonElement>(".sidebar-close")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
      if (event.key !== "Tab") return;
      const controls = sidebarRef.current?.querySelectorAll<HTMLButtonElement>("button");
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    const desktop = window.matchMedia("(min-width: 1025px)");
    const onResize = (): void => { if (desktop.matches) setDrawerOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onResize);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onResize);
      menuButton?.focus();
    };
  }, [drawerOpen]);

  const brand = <><span className="brand-mark"><Mail size={21} aria-hidden="true" /></span><span className="brand-text"><strong>MailDeck<span className="brand-dot">.</span></strong><small>邮箱助手</small></span></>;

  return (
    <div className={cx("app-shell", singleMenu && "app-shell-single")}>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳转到主要内容</a>
      {!singleMenu ? <aside ref={sidebarRef} id="workspace-navigation" className={cx("sidebar", drawerOpen && "sidebar-open")} aria-label="工作空间导航">
        <div className="sidebar-brand">
          {brand}
          <button type="button" className="icon-btn sidebar-close" onClick={() => setDrawerOpen(false)} aria-label="收起菜单"><X size={18} /></button>
        </div>
        <div className="workspace-label"><span className="workspace-symbol">M</span><span><strong>{user.role === "admin" ? "管理工作空间" : "我的工作空间"}</strong><small>MailDeck Workspace</small></span></div>
        <nav className="sidebar-nav" aria-label="主导航">
          {(["管理空间", "个人空间"] as const).map((name) => {
            const entries = items.filter((item) => item.group === name);
            return entries.length ? <div className="nav-group" key={name}>
              <p className="nav-group-label">{name}</p>
              {entries.map((item) => <button key={item.path} type="button" className={cx("nav-item", route === item.path && "nav-item-active")} onClick={() => { setDrawerOpen(false); onNavigate(item.path); }} aria-current={route === item.path ? "page" : undefined}>
                <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>{route === item.path ? <span className="nav-active-dot" aria-hidden="true" /> : null}
              </button>)}
            </div> : null;
          })}
        </nav>
        <div className="sidebar-note"><Mail size={20} aria-hidden="true" /><strong>收信有序，工作从容。</strong><p>把分散的邮箱，放进同一个工作空间。</p></div>
        <div className="sidebar-foot"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><span className="sidebar-account"><strong title={user.username}>{user.username}</strong><small>{ROLE_LABEL[user.role]}</small></span><button type="button" className="icon-btn" onClick={onSignOut} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button></div>
      </aside> : null}
      {!singleMenu && drawerOpen ? <button type="button" className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setDrawerOpen(false)} /> : null}
      <div className="app-main" inert={drawerOpen ? true : undefined}>
        <header className="topbar">
          {singleMenu ? <div className="topbar-brand">{brand}</div> : <button ref={menuRef} type="button" className="icon-btn topbar-menu" onClick={() => setDrawerOpen(true)} aria-label="打开菜单" aria-expanded={drawerOpen} aria-controls="workspace-navigation"><Menu size={20} /></button>}
          <div className="topbar-breadcrumb"><span>{group}</span><ChevronRight size={14} aria-hidden="true" /><strong>{meta.title}</strong></div>
          <div className="topbar-actions">
            <button type="button" className="icon-btn theme-toggle" onClick={cycleTheme} title={`当前主题：${THEME_MODE_LABEL[theme.mode]} · 点击切换`} aria-label={`当前主题：${THEME_MODE_LABEL[theme.mode]}，点击切换主题`}>{themeIcon}</button>
            <span className="topbar-divider" aria-hidden="true" />
            <button type="button" className="btn btn-ghost btn-sm topbar-password" onClick={() => setPasswordOpen(true)} title="修改密码" aria-label="修改密码"><KeyRound size={16} aria-hidden="true" /><span>修改密码</span></button>
            <span className="topbar-role">{ROLE_LABEL[user.role]}</span>
            {singleMenu ? <><span className="avatar" title={user.username}>{user.username.slice(0, 1).toUpperCase()}</span><button type="button" className="icon-btn" onClick={onSignOut} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button></> : null}
          </div>
        </header>
        <main className="page" id="main-content" data-route={route} tabIndex={-1}>
          {route !== ROUTES.mailbox ? (
            <div className="page-heading"><div><p className="page-eyebrow">{meta.eyebrow}</p><h1>{meta.title}</h1><p className="page-description">{meta.subtitle}</p></div><span className="page-heading-mark" aria-hidden="true"><Mail size={24} strokeWidth={1.2} /></span></div>
          ) : null}
          <div className="page-content" key={route} tabIndex={0} aria-label={`${meta.title}内容`}>{children}</div>
          <footer className="page-footer"><span>MailDeck · 邮箱助手</span><span>你的邮箱工作空间</span></footer>
        </main>
      </div>
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}
