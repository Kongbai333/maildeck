import {
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Monitor,
  Moon,
  Play,
  Server,
  Sun,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ROUTES } from "../router";
import type { ThemeMode } from "../theme";
import { THEME_MODE_LABEL, useThemeMode } from "../theme";
import type { Role, SessionUser } from "../types";
import { cx, ROLE_LABEL } from "../utils";
import { Badge } from "./Badge";
import { ChangePasswordModal } from "./ChangePasswordModal";

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  roles: Role[];
  /** 仅当账号拥有「在线播放」权限（或管理员）时显示 */
  needsOnlinePlay?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    path: ROUTES.adminOverview,
    label: "概览",
    icon: <LayoutDashboard size={18} aria-hidden="true" />,
    roles: ["admin"],
  },
  {
    path: ROUTES.adminMailboxes,
    label: "邮箱池",
    icon: <Inbox size={18} aria-hidden="true" />,
    roles: ["admin"],
  },
  {
    path: ROUTES.adminUsers,
    label: "用户管理",
    icon: <Users size={18} aria-hidden="true" />,
    roles: ["admin"],
  },
  {
    path: ROUTES.adminProviders,
    label: "服务商管理",
    icon: <Server size={18} aria-hidden="true" />,
    roles: ["admin"],
  },
  {
    path: ROUTES.mailbox,
    label: "我的邮箱",
    icon: <Mail size={18} aria-hidden="true" />,
    roles: ["user"],
  },
  {
    path: ROUTES.onlinePlay,
    label: "在线播放",
    icon: <Play size={18} aria-hidden="true" />,
    roles: ["admin", "user"],
    needsOnlinePlay: true,
  },
];

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  [ROUTES.adminOverview]: { title: "概览", subtitle: "收信趋势、Top 邮箱、邮箱规模与最近添加" },
  [ROUTES.adminMailboxes]: {
    title: "邮箱池",
    subtitle: "Outlook 账号池 · 域名邮箱池 · 临时邮箱池：导入、生成、分配与维护",
  },
  [ROUTES.adminUsers]: { title: "用户管理", subtitle: "账号、角色与邮箱配额" },
  [ROUTES.adminProviders]: { title: "服务商管理", subtitle: "邮件服务商、API Key 与域名" },
  [ROUTES.mailbox]: { title: "我的邮箱", subtitle: "领取邮箱并查看收件箱" },
  [ROUTES.onlinePlay]: { title: "在线播放", subtitle: "聚合在线频道，点击即可播放" },
};

export interface AppShellProps {
  user: SessionUser;
  route: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function AppShell({
  user,
  route,
  onNavigate,
  onSignOut,
  children,
}: AppShellProps): ReactNode {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const theme = useThemeMode();

  const themeIcon =
    theme.mode === "light" ? (
      <Sun size={16} aria-hidden="true" />
    ) : theme.mode === "dark" ? (
      <Moon size={16} aria-hidden="true" />
    ) : (
      <Monitor size={16} aria-hidden="true" />
    );
  const cycleTheme = (): void => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(theme.mode) + 1) % order.length];
    theme.setMode(next);
  };

  const items = NAV_ITEMS.filter(
    (item) =>
      item.roles.includes(user.role) &&
      (!item.needsOnlinePlay || user.role === "admin" || user.canOnlinePlay === true),
  );
  // 只有一个菜单项时（例如普通用户只有「我的邮箱」），侧边菜单栏没有意义，直接不渲染。
  const singleMenu = items.length <= 1;
  const meta = PAGE_META[route] ?? { title: "MailDeck", subtitle: "" };

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const go = (path: string): void => {
    setDrawerOpen(false);
    onNavigate(path);
  };

  return (
    <div className={cx("app-shell", singleMenu && "app-shell-single")}>
      {singleMenu ? null : (
      <aside className={cx("sidebar", drawerOpen && "sidebar-open")}>
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Mail size={18} aria-hidden="true" />
          </span>
          <span className="brand-text">
            <strong>MailDeck</strong>
            <small>邮箱助手</small>
          </span>
          <button
            type="button"
            className="icon-btn sidebar-close"
            onClick={() => setDrawerOpen(false)}
            aria-label="收起菜单"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {items.map((item) => {
            const active = route === item.path;
            return (
              <button
                key={item.path}
                type="button"
                className={cx("nav-item", active && "nav-item-active")}
                onClick={() => go(item.path)}
                aria-current={active ? "page" : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <span className="sidebar-foot-line">会话账号</span>
          <span className="sidebar-foot-user">{user.username}</span>
        </div>
      </aside>
      )}

      {!singleMenu && drawerOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭菜单"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="topbar">
          {singleMenu ? (
            <div className="topbar-brand">
              <span className="brand-mark">
                <Mail size={18} aria-hidden="true" />
              </span>
              <span className="brand-text">
                <strong>MailDeck</strong>
                <small>邮箱助手</small>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="icon-btn topbar-menu"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开菜单"
            >
              <Menu size={20} aria-hidden="true" />
            </button>
          )}
          <div className="topbar-title">
            <h1>{meta.title}</h1>
            {meta.subtitle ? <p>{meta.subtitle}</p> : null}
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm theme-toggle"
              onClick={cycleTheme}
              title={`当前主题：${THEME_MODE_LABEL[theme.mode]}（点击切换 浅色 / 深色 / 跟随系统）`}
              aria-label={`当前主题：${THEME_MODE_LABEL[theme.mode]}，点击切换主题`}
            >
              {themeIcon}
              <span className="theme-toggle-label">{THEME_MODE_LABEL[theme.mode]}</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm topbar-password"
              onClick={() => setPasswordOpen(true)}
            >
              <KeyRound size={16} aria-hidden="true" />
              <span>修改密码</span>
            </button>
            <div className="user-chip" title={user.username}>
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <span className="user-chip-text">
                <strong>{user.username}</strong>
                <Badge tone={user.role === "admin" ? "badge-primary" : "badge-muted"}>
                  {ROLE_LABEL[user.role]}
                </Badge>
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onSignOut}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <main className="page">{children}</main>
      </div>

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}
