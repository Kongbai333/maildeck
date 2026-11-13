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
import "../../styles/entry-overview.css";

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
    <div className="md-overview" role="status" aria-label="正在加载概览" aria-busy="true">
      <div className="md-overview-toolbar"><Skeleton width={180} height={34} /></div>
      <section className="md-overview-metrics">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="md-overview-metric" key={index}>
            <Skeleton width={72} height={12} />
            <Skeleton width={96} height={32} />
            <Skeleton width="75%" height={12} />
          </div>
        ))}
      </section>
      <div className="md-overview-analytics">
        <section className="md-overview-panel">
          <div className="md-overview-panel-head"><Skeleton width={160} height={16} /></div>
          <div className="md-overview-chart-placeholder"><Skeleton width="100%" height={184} radius={6} /></div>
        </section>
        <section className="md-overview-panel">
          <div className="md-overview-panel-head"><Skeleton width={100} height={16} /></div>
          <TableSkeleton rows={3} columns={2} />
        </section>
      </div>
      <div className="md-overview-records">
        {[0, 1].map((index) => (
          <section className="md-overview-panel" key={index}>
            <div className="md-overview-panel-head"><Skeleton width={150} height={16} /></div>
            <TableSkeleton rows={4} columns={2} />
          </section>
        ))}
      </div>
    </div>
  );
}

/** 四项指标、收信趋势与邮箱分布、最近邮箱与收信排行。页面隐藏时暂停 30 秒轮询。 */
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
      <div className="md-overview">
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
  const mailboxKinds = ["outlook", "domain", "temp"] as const;

  return (
    <div className="md-overview">
      <div className="md-overview-toolbar">
        <div>
          <p className="md-overview-welcome">欢迎回来，工作台已就绪。</p>
          <p className="md-overview-updated">
            <span className={cx("md-overview-sync", error !== null && "md-overview-sync-error")} aria-hidden="true" />
            {updatedAt !== null ? `更新于 ${formatClock(updatedAt)} · 每 30 秒自动刷新` : "每 30 秒自动刷新"}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading ? "刷新中…" : "刷新数据"}
        </button>
      </div>

      {error !== null ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="md-overview-metrics" aria-label="收信与领取概况">
        <article className="md-overview-metric md-overview-metric-featured">
          <div className="md-overview-metric-label"><span>今日收信</span><Mail size={17} aria-hidden="true" /></div>
          <strong className="md-overview-metric-value">{stats.messages.today}<small>封</small></strong>
          <p className="md-overview-metric-hint">今日 0 点至当前</p>
        </article>
        <article className="md-overview-metric">
          <div className="md-overview-metric-label"><span>近 7 天收信</span><CalendarDays size={17} aria-hidden="true" /></div>
          <strong className="md-overview-metric-value">{stats.messages.last7d}<small>封</small></strong>
          <p className="md-overview-metric-hint">含今天在内的 7 天累计</p>
        </article>
        <article className="md-overview-metric">
          <div className="md-overview-metric-label"><span>累计收信</span><Layers size={17} aria-hidden="true" /></div>
          <strong className="md-overview-metric-value">{stats.messages.total}<small>封</small></strong>
          <p className="md-overview-metric-hint">Outlook {stats.messages.byKind.outlook} · 域名 {stats.messages.byKind.domain} · 临时 {stats.messages.byKind.temp}</p>
        </article>
        <article className="md-overview-metric">
          <div className="md-overview-metric-label"><span>今日领取</span><UserCheck size={17} aria-hidden="true" /></div>
          <strong className="md-overview-metric-value">{stats.claimsToday}<small>个</small></strong>
          <p className="md-overview-metric-hint">普通用户今日领取的邮箱</p>
        </article>
      </section>

      <div className="md-overview-analytics">
        <section className="md-overview-panel" aria-labelledby="md-overview-trend-title">
          <header className="md-overview-panel-head">
            <div>
              <h2 id="md-overview-trend-title"><TrendingUp size={17} aria-hidden="true" />收信趋势</h2>
              <p>近 7 天 · 按本地日期统计</p>
            </div>
            <span className="md-overview-panel-note">单位 / 封</span>
          </header>
          <div className="md-overview-chart">
            {daily.length === 0 ? (
              <p className="md-overview-chart-empty">暂无趋势数据</p>
            ) : (
              <>
                <div className="md-overview-chart-axis" aria-hidden="true">
                  <span>{niceMax}</span><span>{Math.round(niceMax / 2)}</span><span>0</span>
                </div>
                <div className="md-overview-chart-plot">
                  <div className="md-overview-chart-grid" aria-hidden="true"><span /><span /><span /></div>
                  <div
                    className="md-overview-chart-bars"
                    role="img"
                    aria-label={`近 7 天收信趋势：${daily.map((item) => `${item.date} ${item.count} 封`).join("，")}`}
                  >
                    {daily.map((item) => {
                      const pct = niceMax === 0 ? 0 : Math.round((item.count / niceMax) * 100);
                      return (
                        <div
                          className={cx("md-overview-chart-col", item.count === 0 && "md-overview-chart-zero")}
                          key={item.date}
                          title={`${item.date}：${item.count} 封`}
                        >
                          <div className="md-overview-chart-track">
                            <div className="md-overview-chart-bar" style={{ height: `${Math.max(pct, 2)}%` }}>
                              <span className="md-overview-chart-value">{item.count}</span>
                            </div>
                          </div>
                          <span className="md-overview-chart-date">{formatMonthDay(item.date)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="md-overview-panel" aria-labelledby="md-overview-distribution-title">
          <header className="md-overview-panel-head">
            <div><h2 id="md-overview-distribution-title">邮箱分布</h2><p>已接入的三类邮箱</p></div>
            <span className="md-overview-total">{stats.mailboxes.total}<small>个邮箱</small></span>
          </header>
          <div className="md-overview-distribution">
            <div className="md-overview-distribution-bar" aria-hidden="true">
              {mailboxKinds.map((kind) => (
                <span
                  key={kind}
                  className={`md-overview-kind-${kind}`}
                  style={{ flexGrow: stats.mailboxes[kind] }}
                />
              ))}
            </div>
            {stats.mailboxes.total === 0 ? <p className="md-overview-distribution-empty">暂无邮箱，添加后即可查看分布。</p> : null}
            <ul className="md-overview-kind-list">
              {mailboxKinds.map((kind) => (
                <li key={kind}>
                  <span className="md-overview-kind-label"><i className={`md-overview-kind-${kind}`} aria-hidden="true" />{PROVIDER_KIND_SHORT[kind]}邮箱</span>
                  <strong>{stats.mailboxes[kind]}</strong>
                  <span className="md-overview-kind-share">{stats.mailboxes.total > 0 ? `${Math.round((stats.mailboxes[kind] / stats.mailboxes.total) * 100)}%` : "—"}</span>
                </li>
              ))}
            </ul>
          </div>
          {overview !== null ? (
            <div className="md-overview-context">
              <span>用户 <strong>{overview.users.total}</strong><small>启用 {overview.users.active}</small></span>
              <span>服务商 <strong>{overview.providers.total}</strong><small>启用 {overview.providers.enabled}</small></span>
            </div>
          ) : null}
        </section>
      </div>

      <div className="md-overview-records">
        <section className="md-overview-panel" aria-labelledby="md-overview-recent-title">
          <header className="md-overview-panel-head">
            <div><h2 id="md-overview-recent-title">最近添加</h2><p>邮箱池里最新的 6 个地址</p></div>
            <button type="button" className="md-overview-text-link" onClick={() => onNavigate(ROUTES.adminMailboxes)}>
              邮箱池<ArrowRight size={15} aria-hidden="true" />
            </button>
          </header>
          {recent.length === 0 ? (
            <EmptyState
              compact
              icon={<Inbox size={22} aria-hidden="true" />}
              title="邮箱池还是空的"
              description="到「邮箱池」生成或批量导入邮箱后，这里会显示最新地址。"
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate(ROUTES.adminMailboxes)}>去生成邮箱</button>}
            />
          ) : (
            <ul className="md-overview-recent-list">
              {recent.map((row) => (
                <li key={row.id}>
                  <div className="md-overview-recent-main">
                    <span className="md-overview-address" title={row.email}>{row.email}</span>
                    <Badge tone={MAILBOX_STATUS_TONE[row.status]}>{MAILBOX_STATUS_LABEL[row.status]}</Badge>
                  </div>
                  <div className="md-overview-recent-meta">
                    <span title={row.providerName}>服务商 · {row.providerName}</span>
                    <span title={row.assignedUsername ?? undefined}>归属 · {row.assignedUsername ?? "—"}</span>
                    <time dateTime={row.createdAt}>创建 · {formatDateTime(row.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="md-overview-panel" aria-labelledby="md-overview-ranking-title">
          <header className="md-overview-panel-head">
            <div><h2 id="md-overview-ranking-title">收信排行<span className="md-overview-heading-tag">TOP 10</span></h2><p>累计收信最多的邮箱 · 点击查看邮箱池</p></div>
            <button type="button" className="md-overview-text-link" onClick={() => onNavigate(ROUTES.adminMailboxes)} aria-label="前往邮箱池查看收信排行">
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </header>
          {topMailboxes.length === 0 ? (
            <EmptyState
              compact
              icon={<Mail size={22} aria-hidden="true" />}
              title="还没有收信记录"
              description="用户把邮箱用于注册后，收到的邮件会累计在这里。"
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate(ROUTES.adminMailboxes)}>去邮箱池</button>}
            />
          ) : (
            <ol className="md-overview-ranking">
              {topMailboxes.map((row, index) => (
                <li key={`${row.kind}-${row.email}`}>
                  <button
                    type="button"
                    className="md-overview-rank-row"
                    onClick={() => onNavigate(ROUTES.adminMailboxes)}
                    title={`查看邮箱池 · ${row.email}`}
                  >
                    <span className={cx("md-overview-rank-number", index < 3 && "md-overview-rank-top")}>{String(index + 1).padStart(2, "0")}</span>
                    <span className="md-overview-rank-mail"><span className="md-overview-address">{row.email}</span><Badge tone={PROVIDER_KIND_TONE[row.kind]}>{PROVIDER_KIND_SHORT[row.kind]}</Badge></span>
                    <span className="md-overview-rank-count">{row.count}<small>封</small></span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
