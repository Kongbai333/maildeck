import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fetchMe, isUnauthorizedError, logout } from "./api";
import { AppShell } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { LoginPage } from "./components/LoginPage";
import { Spinner } from "./components/Spinner";
import { MailboxesPage } from "./pages/admin/MailboxesPage";
import { OverviewPage } from "./pages/admin/OverviewPage";
import { ProvidersPage } from "./pages/admin/ProvidersPage";
import { UsersPage } from "./pages/admin/UsersPage";
import { MyMailboxPage } from "./pages/user/MyMailboxPage";
import { OnlinePlayPage } from "./pages/user/OnlinePlayPage";
import { isKnownRoute, LEGACY_ROUTE_REDIRECTS, navigate, ROUTES, useRoute } from "./router";
import { errorText, SessionProvider } from "./session";
import type { SessionUser } from "./types";

function homeFor(user: SessionUser): string {
  return user.role === "admin" ? ROUTES.adminOverview : ROUTES.mailbox;
}

function ForbiddenNotice(): ReactNode {
  return (
    <section className="card">
      <EmptyState
        icon={<ShieldAlert size={22} aria-hidden="true" />}
        title="没有访问权限"
        description="当前账号是普通用户，无法访问管理员页面，正在返回「我的邮箱」…"
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate(ROUTES.mailbox, true)}
          >
            立即返回
          </button>
        }
      />
    </section>
  );
}

export function App(): ReactNode {
  const route = useRoute();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootToken, setBootToken] = useState(0);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setBooting(true);
    setBootError(null);
    fetchMe(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setUser(value);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorizedError(cause)) {
          setUser(null);
          return;
        }
        setBootError(errorText(cause, "会话检查失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, [bootToken]);

  const signOut = useCallback((): void => {
    void logout().catch(() => undefined);
    setUser(null);
    setForbidden(false);
    navigate(ROUTES.login, true);
  }, []);

  // 未登录 → 登录页；已登录 → 按角色落到首页；普通用户访问 admin 路由 → 提示后跳回
  useEffect(() => {
    if (booting) return undefined;

    if (user === null) {
      if (route !== ROUTES.login) navigate(ROUTES.login, true);
      return undefined;
    }

    // 旧路由重定向（统计页已并入概览）
    const legacyTarget = LEGACY_ROUTE_REDIRECTS[route];
    if (legacyTarget !== undefined) {
      navigate(legacyTarget, true);
      return undefined;
    }

    if (route === ROUTES.login || route === "/" || !isKnownRoute(route)) {
      navigate(homeFor(user), true);
      return undefined;
    }

    if (user.role !== "admin" && route.startsWith("/admin")) {
      setForbidden(true);
      const timer = window.setTimeout(() => {
        setForbidden(false);
        navigate(ROUTES.mailbox, true);
      }, 1600);
      return () => window.clearTimeout(timer);
    }

    setForbidden(false);
    return undefined;
  }, [booting, route, user]);

  const sessionValue = useMemo(
    () => (user === null ? null : { user, setUser, signOut }),
    [signOut, user],
  );

  if (booting) {
    return (
      <div className="boot-screen">
        <Spinner size={26} label="正在检查登录状态…" />
      </div>
    );
  }

  if (bootError !== null) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <h1>无法连接服务</h1>
          <p>{bootError}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setBootToken((prev) => prev + 1)}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (user === null || sessionValue === null) {
    return (
      <LoginPage
        onSuccess={(next) => {
          setUser(next);
          setForbidden(false);
          navigate(homeFor(next), true);
        }}
      />
    );
  }

  const onNavigate = (path: string): void => {
    navigate(path);
  };

  let page: ReactNode;
  if (forbidden) {
    page = <ForbiddenNotice />;
  } else if (route === ROUTES.adminOverview) {
    page = <OverviewPage onNavigate={onNavigate} />;
  } else if (route === ROUTES.adminMailboxes) {
    page = <MailboxesPage />;
  } else if (route === ROUTES.adminUsers) {
    page = <UsersPage />;
  } else if (route === ROUTES.adminProviders) {
    page = <ProvidersPage />;
  } else if (route === ROUTES.onlinePlay) {
    page = <OnlinePlayPage />;
  } else {
    page = <MyMailboxPage />;
  }

  return (
    <SessionProvider value={sessionValue}>
      <AppShell user={user} route={route} onNavigate={onNavigate} onSignOut={signOut}>
        {page}
      </AppShell>
    </SessionProvider>
  );
}
