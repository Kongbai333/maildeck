import {
  ArrowRight,
  CalendarDays,
  Inbox,
  Layers,
  Mail,
  RefreshCw,
  TrendingUp,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { adminMailboxes, adminOverview, adminStats, isAbortError, isUnauthorizedError } from "../../api";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { Skeleton, TableSkeleton } from "../../components/Skeleton";
import { ROUTES } from "../../router";
import { errorText, useApiFailure } from "../../session";
import type { AdminMailboxView, AdminStats, Overview } from "../../types";
import {
  cx,
  formatDateTime,
  MAILBOX_STATUS_LABEL,
  MAILBOX_STATUS_TONE,
  PROVIDER_KIND_SHORT,
  PROVIDER_KIND_TONE,
} from "../../utils";

/** 概览与统计合并后的自动刷新间隔 */
const REFRESH_MS = 30_000;

export interface OverviewPageProps {
  onNavigate: (path: string) => void;
}

function formatMonthDay(value: string): string {
  const parts = value.split("-");
  if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}`;
  return value;
}

function formatClock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function OverviewSkeleton(): ReactNode {
  return (
    <div className="page-stack">
      <section className="stat-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="stat-card" key={index}>
            <Skeleton width={48} height={48} radius={14} />
            <div className="stat-body">
              <Skeleton width={72} height={12} />
              <Skeleton width={96} height={30} />
              <Skeleton width={120} height={12} />
            </div>
          </div>
        ))}
      </section>
      <section className="stats-mini-grid">
        {Array.from({ length: 3 }).map((_, index) => (
          <div className="stats-mini-card" key={index}>
            <Skeleton width={60} height={12} />
            <Skeleton width={80} height={26} />
          </div>
        ))}
      </section>
      <section className="card">
        <div className="card-head">
          <Skeleton width={160} height={16} />
        </div>
        <div className="chart-skeleton">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} width="100%" height={40 + ((index * 37) % 120)} radius={8} />
          ))}
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <Skeleton width={180} height={16} />
        </div>
        <TableSkeleton rows={5} columns={3} />
      </section>
    </div>
  );
}

/**
 * 概览页：原「概览」+ 原「统计」合并。
 * - 顶部 4 张数字卡：今日收信 / 近 7 天 / 累计收信 / 今日领取
 * - 三类邮箱规模小卡
 * - 近 7 天收信趋势图 + Top10 收信邮箱表
 * - 最近添加的邮箱（保留跳转邮箱池入口）
 * 每 30 秒轮询 /api/admin/stats + /api/admin/overview，页面隐藏时暂停。
 */
export function OverviewPage({ onNavigate }: OverviewPageProps): ReactNode {
  const handleFailure = useApiFailure();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<AdminMailboxView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((prev) => prev + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      adminStats(controller.signal),
      adminOverview(controller.signal),
      adminMailboxes({}, controller.signal),
    ])
      .then(([statsValue, overviewValue, boxes]) => {
        if (controller.signal.aborted) return;
        setStats(statsValue);
        setOverview(overviewValue);
        setRecent(
          [...boxes].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 6),
        );
        setUpdatedAt(new Date());
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "概览加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, token]);

  // 30 秒自动刷新：页面隐藏时暂停，重新可见立即补一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setToken((prev) => prev + 1);
    }, REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") setToken((prev) => prev + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const chart = useMemo(() => {
    const daily = stats?.daily ?? [];
    const maxCount = daily.reduce((max, item) => Math.max(max, item.count), 0);
    const niceMax = Math.max(1, Math.ceil(maxCount / 4) * 4);
    return { daily, maxCount, niceMax };
  }, [stats]);

  if (loading && stats === null) {
    return <OverviewSkeleton />;
  }

  if (error !== null && stats === null) {
    return (
      <div className="page-stack">
        <div className="alert alert-error" role="alert">
          {error}
        </div>
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
            <RefreshCw size={15} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    );
  }

  if (stats === null) return null;

  const topMailboxes = stats.topMailboxes ?? [];
  const { daily, niceMax } = chart;

  return (
    <div className="page-stack stats-page">
      <div className="stats-toolbar">
        <p className="stats-updated">
          {updatedAt !== null ? `数据更新于 ${formatClock(updatedAt)} · 每 30 秒自动刷新` : "每 30 秒自动刷新"}
          {overview !== null ? (
            <span className="overview-meta">
              {"  ·  "}用户 {overview.users.total}（启用 {overview.users.active}） · 服务商 {overview.providers.total}
              （启用 {overview.providers.enabled}）
            </span>
          ) : null}
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </div>

      {error !== null ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="stat-grid">
        <article className="stat-card">
          <span className="stat-icon stat-icon-primary">
            <Mail size={18} aria-hidden="true" />
          </span>
          <div className="stat-body">
            <span className="stat-label">今日收信</span>
            <strong className="stat-value">{stats.messages.today}</strong>
            <span className="stat-hint">今日 0 点至当前的收信数</span>
          </div>
        </article>

        <article className="stat-card">
          <span className="stat-icon stat-icon-info">
            <CalendarDays size={18} aria-hidden="true" />
          </span>
          <div className="stat-body">
            <span className="stat-label">近 7 天收信</span>
            <strong className="stat-value">{stats.messages.last7d}</strong>
            <span className="stat-hint">含今天在内的 7 天累计</span>
          </div>
        </article>

        <article className="stat-card">
          <span className="stat-icon stat-icon-warning">
            <Layers size={18} aria-hidden="true" />
          </span>
          <div className="stat-body">
            <span className="stat-label">累计收信</span>
            <strong className="stat-value">{stats.messages.total}</strong>
            <span className="stat-hint">
              Outlook {stats.messages.byKind.outlook} · 域名 {stats.messages.byKind.domain} · 临时{" "}
              {stats.messages.byKind.temp}
            </span>
          </div>
        </article>

        <article className="stat-card">
          <span className="stat-icon stat-icon-success">
            <UserCheck size={18} aria-hidden="true" />
          </span>
          <div className="stat-body">
            <span className="stat-label">今日领取</span>
            <strong className="stat-value">{stats.claimsToday}</strong>
            <span className="stat-hint">普通用户今日领取的邮箱数</span>
          </div>
        </article>
      </section>

      <section className="stats-mini-grid" aria-label="邮箱总数按类型">
        <article className="stats-mini-card">
          <span className="stats-mini-label">
            <Badge tone={PROVIDER_KIND_TONE.outlook}>{PROVIDER_KIND_SHORT.outlook}</Badge>
            邮箱
          </span>
          <strong className="stats-mini-value">{stats.mailboxes.outlook}</strong>
        </article>
        <article className="stats-mini-card">
          <span className="stats-mini-label">
            <Badge tone={PROVIDER_KIND_TONE.domain}>{PROVIDER_KIND_SHORT.domain}</Badge>
            邮箱
          </span>
          <strong className="stats-mini-value">{stats.mailboxes.domain}</strong>
        </article>
        <article className="stats-mini-card">
          <span className="stats-mini-label">
            <Badge tone={PROVIDER_KIND_TONE.temp}>{PROVIDER_KIND_SHORT.temp}</Badge>
            邮箱
          </span>
          <strong className="stats-mini-value">{stats.mailboxes.temp}</strong>
        </article>
      </section>

      <section className="card">
        <header className="card-head">
          <div>
            <h2 className="card-title">
              <TrendingUp size={17} aria-hidden="true" className="card-title-icon" />
              近 7 天收信趋势
            </h2>
            <p className="card-desc">按本地日期统计，鼠标悬停柱体查看当天收信数</p>
          </div>
        </header>
        <div className="chart-body">
          {daily.length === 0 ? (
            <div className="chart-empty cell-muted">暂无趋势数据</div>
          ) : (
            <>
              <div className="chart-axis" aria-hidden="true">
                <span>{niceMax}</span>
                <span>{Math.round(niceMax / 2)}</span>
                <span>0</span>
              </div>
              <div className="chart-plot">
                <div className="chart-grid" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="chart-bars" role="img" aria-label="近 7 天收信趋势柱状图">
                  {daily.map((item) => {
                    const pct = niceMax === 0 ? 0 : Math.round((item.count / niceMax) * 100);
                    return (
                      <div
                        className={cx("chart-col", item.count === 0 && "chart-col-zero")}
                        key={item.date}
                        title={`${item.date}：${item.count} 封`}
                      >
                        <div className="chart-bar-track">
                          <div className="chart-bar" style={{ height: `${Math.max(pct, 2)}%` }}>
                            <span className="chart-value">{item.count}</span>
                          </div>
                        </div>
                        <span className="chart-date">{formatMonthDay(item.date)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <div>
            <h2 className="card-title">收信最多的邮箱 Top10</h2>
            <p className="card-desc">点击任意行可跳转到「邮箱池」查看详情</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onNavigate(ROUTES.adminMailboxes)}
          >
            前往邮箱池
          </button>
        </header>
        {topMailboxes.length === 0 ? (
          <EmptyState
            compact
            icon={<Mail size={22} aria-hidden="true" />}
            title="还没有收信记录"
            description="用户把邮箱用于注册后，收到的邮件会累计在这里。"
            action={
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onNavigate(ROUTES.adminMailboxes)}
              >
                去邮箱池
              </button>
            }
          />
        ) : (
          <div className="table-wrap stats-table-wrap">
            <table className="table table-stats">
              <colgroup>
                <col className="col-rank" />
                <col className="col-email" />
                <col className="col-kind" />
                <col className="col-count" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-rank">#</th>
                  <th className="col-email">邮箱</th>
                  <th className="col-kind">类型</th>
                  <th className="col-count">收信数</th>
                </tr>
              </thead>
              <tbody>
                {topMailboxes.map((row, index) => (
                  <tr
                    key={`${row.kind}-${row.email}`}
                    className="clickable-row"
                    onClick={() => onNavigate(ROUTES.adminMailboxes)}
                    title={`查看邮箱池 · ${row.email}`}
                  >
                    <td className="col-rank">
                      <span className={cx("rank-badge", index < 3 && "rank-badge-top")}>{index + 1}</span>
                    </td>
                    <td className="col-email cell-strong" title={row.email}>
                      {row.email}
                    </td>
                    <td className="col-kind">
                      <Badge tone={PROVIDER_KIND_TONE[row.kind]}>
                        {PROVIDER_KIND_SHORT[row.kind]}
                      </Badge>
                    </td>
                    <td className="col-count stat-count">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <header className="card-head">
          <div>
            <h2 className="card-title">最近添加的邮箱</h2>
            <p className="card-desc">邮箱池里最新的 6 个地址</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onNavigate(ROUTES.adminMailboxes)}
          >
            前往邮箱池
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </header>

        {recent.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} aria-hidden="true" />}
            title="邮箱池还是空的"
            description="到「邮箱池」生成或批量导入邮箱后，这里会显示最新地址。"
            action={
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onNavigate(ROUTES.adminMailboxes)}
              >
                去生成邮箱
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-recent">
              <colgroup>
                <col className="col-email" />
                <col className="col-provider" />
                <col className="col-status" />
                <col className="col-owner" />
                <col className="col-created" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-email">邮箱地址</th>
                  <th className="col-provider">服务商</th>
                  <th className="col-status">状态</th>
                  <th className="col-owner">归属</th>
                  <th className="col-created">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td className="col-email cell-strong" title={row.email}>
                      {row.email}
                    </td>
                    <td className="col-provider" title={row.providerName}>
                      {row.providerName}
                    </td>
                    <td className="col-status">
                      <Badge tone={MAILBOX_STATUS_TONE[row.status]}>
                        {MAILBOX_STATUS_LABEL[row.status]}
                      </Badge>
                    </td>
                    <td className="col-owner" title={row.assignedUsername ?? undefined}>
                      {row.assignedUsername ?? "—"}
                    </td>
                    <td className="col-created cell-muted">{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
