import { Copy, Inbox, Mail, Plus, RefreshCw, RotateCcw, Tag, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  clearMyMessages,
  deleteMyMessage,
  fetchMe,
  isAbortError,
  isUnauthorizedError,
  myMailboxes,
  myMessage,
  myMessages,
  myProviders,
  releaseMailbox,
  updateMyMailboxTags,
} from "../../api";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { MailboxInboxPanel } from "../../components/MailboxInboxPanel";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { TagChips } from "../../components/TagChips";
import { TagEditorModal } from "../../components/TagEditorModal";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure, useSession } from "../../session";
import type {
  AcquireMailboxResult,
  MailboxView,
  ProviderKind,
  ProviderOption,
  QuotaBuckets,
} from "../../types";
import {
  copyText,
  cx,
  emptyQuota,
  PROVIDER_KIND_LABEL,
  PROVIDER_KIND_ORDER,
  PROVIDER_KIND_SHORT,
  PROVIDER_KIND_TONE,
  quotaLimits,
  quotaRemaining,
} from "../../utils";
import { AcquireMailboxModal } from "./AcquireMailboxModal";
import { ImportMyMailboxModal } from "./ImportMyMailboxModal";

type TabValue = "all" | ProviderKind;

const TABS: readonly { value: TabValue; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "outlook", label: "Outlook" },
  { value: "temp", label: "临时" },
  { value: "domain", label: "域名" },
];

export function MyMailboxPage(): ReactNode {
  const { user, setUser } = useSession();
  const toast = useToast();
  const handleFailure = useApiFailure();

  const [mailboxes, setMailboxes] = useState<MailboxView[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabValue>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<MailboxView | null>(null);
  const [tagTarget, setTagTarget] = useState<MailboxView | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [token, setToken] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [acquireOpen, setAcquireOpen] = useState(false);

  const reload = useCallback(() => setToken((prev) => prev + 1), []);

  // 拉一次最新的会话，用于刷新配额（已用额度由服务端统计，不按前端邮箱数量算）
  const syncSession = useCallback(async (): Promise<void> => {
    try {
      const latest = await fetchMe();
      setUser(latest);
    } catch {
      /* 静默：配额刷新失败不影响列表 */
    }
  }, [setUser]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    myMailboxes(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setMailboxes(list);
        setError(null);
        setActiveId((prev) => {
          if (prev !== null && list.some((item) => item.id === prev)) return prev;
          return list.length > 0 ? list[0].id : null;
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "邮箱加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, token]);

  // 服务商类别用于给没有 kind 字段的邮箱分类（老后端兜底）
  useEffect(() => {
    const controller = new AbortController();
    myProviders(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setProviders(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProviders([]);
      });
    return () => controller.abort();
  }, [token]);

  const kindByProvider = useMemo(() => {
    const map = new Map<string, ProviderKind>();
    for (const item of providers) map.set(item.id, item.kind);
    return map;
  }, [providers]);

  const kindOf = useCallback(
    (mailbox: MailboxView): ProviderKind =>
      mailbox.kind ?? kindByProvider.get(mailbox.providerId) ?? "outlook",
    [kindByProvider],
  );

  const limits = quotaLimits(user.quotas, user.mailboxQuota);
  const usage: QuotaBuckets = user.quotaUsage ?? emptyQuota();
  const remaining = quotaRemaining(limits, usage);
  const allFull = remaining.outlook + remaining.domain + remaining.temp <= 0;

  // 各类型数量（用于标签页计数）
  const kindCounts = useMemo(() => {
    const counts = emptyQuota();
    for (const item of mailboxes) counts[kindOf(item)] += 1;
    return counts;
  }, [mailboxes, kindOf]);

  // 现有邮箱里出现过的标签集合，用于标签筛选下拉
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of mailboxes) for (const tag of item.tags) set.add(tag);
    return Array.from(set).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  }, [mailboxes]);

  const filteredMailboxes = useMemo(
    () =>
      mailboxes.filter((item) => {
        if (tab !== "all" && kindOf(item) !== tab) return false;
        if (tagFilter !== "" && !item.tags.includes(tagFilter)) return false;
        return true;
      }),
    [kindOf, mailboxes, tab, tagFilter],
  );

  const active = useMemo(
    () => mailboxes.find((item) => item.id === activeId) ?? null,
    [activeId, mailboxes],
  );

  const onAcquired = (result: AcquireMailboxResult): void => {
    setActiveId(result.mailbox.id);
    reload();
    void syncSession();
  };

  const onCopy = async (email: string): Promise<void> => {
    const copied = await copyText(email);
    if (copied) toast.success(`已复制：${email}`);
    else toast.error(`复制失败，请手动选中复制：${email}`);
  };

  const onRelease = async (): Promise<void> => {
    if (releaseTarget === null) return;
    setReleasing(true);
    try {
      await releaseMailbox(releaseTarget.id);
      toast.success("邮箱已释放");
      setReleaseTarget(null);
      setActiveId(null);
      reload();
      void syncSession();
    } catch (cause) {
      handleFailure(cause, "释放邮箱失败");
    } finally {
      setReleasing(false);
    }
  };

  const saveTags = async (next: string[]): Promise<void> => {
    if (tagTarget === null) return;
    const saved = await updateMyMailboxTags(tagTarget.id, next);
    setMailboxes((prev) =>
      prev.map((item) => (item.id === tagTarget.id ? { ...item, tags: saved } : item)),
    );
    setTagTarget(null);
    toast.success("标签已更新");
  };

  const handleDeleteMessage = async (messageId: string): Promise<void> => {
    if (active === null) return;
    await deleteMyMessage(active.id, messageId);
  };

  const handleClearInbox = async (): Promise<void> => {
    if (active === null) return;
    await clearMyMessages(active.id);
  };

  const refreshInbox = (): void => setRefreshKey((prev) => prev + 1);

  const acquireTitle = allFull
    ? `三类配额都已用满（Outlook ${usage.outlook}/${limits.outlook}、域名 ${usage.domain}/${limits.domain}、临时 ${usage.temp}/${limits.temp}）`
    : "从账号池领取 Outlook，或生成域名 / 临时邮箱地址";
  const importTitle = "导入自己的 Outlook 账号，不占配额";

  const emptyListText =
    tab === "all"
      ? tagFilter !== ""
        ? "没有符合该标签的邮箱"
        : "还没有邮箱"
      : `还没有${PROVIDER_KIND_SHORT[tab]}邮箱${tagFilter !== "" ? "符合该标签" : ""}`;

  const renderAcquireButton = (extraClass = ""): ReactNode => (
    <button
      type="button"
      className={cx("btn btn-primary btn-sm", extraClass)}
      onClick={() => setAcquireOpen(true)}
      disabled={allFull}
      title={acquireTitle}
    >
      <Plus size={15} aria-hidden="true" />
      获取邮箱
    </button>
  );

  const renderMetaBadges = (item: MailboxView, kind: ProviderKind): ReactNode => (
    <span className="mailbox-item-meta">
      <Badge tone={PROVIDER_KIND_TONE[kind]}>{PROVIDER_KIND_SHORT[kind]}</Badge>
      {item.quotaExempt ? <Badge tone="badge-muted">不占配额</Badge> : null}
    </span>
  );

  const renderActions = (item: MailboxView): ReactNode => (
    <>
      <button
        type="button"
        className="icon-btn icon-btn-xs"
        onClick={() => setTagTarget(item)}
        title="编辑标签"
        aria-label={`编辑标签 ${item.email}`}
      >
        <Tag size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-xs"
        onClick={() => void onCopy(item.email)}
        title="复制地址"
        aria-label={`复制地址 ${item.email}`}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-xs icon-btn-danger"
        onClick={() => setReleaseTarget(item)}
        title="释放邮箱"
        aria-label={`释放邮箱 ${item.email}`}
      >
        <RotateCcw size={14} aria-hidden="true" />
      </button>
    </>
  );

  const renderListItem = (item: MailboxView): ReactNode => {
    const kind = kindOf(item);
    const isActive = item.id === activeId;
    return (
      <article key={item.id} className={cx("mailbox-item", isActive && "mailbox-item-active")}>
        <button
          type="button"
          className="mailbox-item-main"
          onClick={() => setActiveId(item.id)}
          aria-pressed={isActive}
          title={item.email}
        >
          <span className="mailbox-item-icon">
            <Mail size={16} aria-hidden="true" />
          </span>
          <span className="mailbox-item-text">
            <strong className="mailbox-address" title={item.email}>
              {item.email}
            </strong>
            {renderMetaBadges(item, kind)}
            <TagChips tags={item.tags} max={3} className="mailbox-item-tags" />
          </span>
        </button>
        <div className="mailbox-item-actions">{renderActions(item)}</div>
      </article>
    );
  };

  return (
    <div className="page-stack my-mailbox-page">
      <section className="card">
        <div className="toolbar mailbox-toolbar">
          <div className="toolbar-left mailbox-toolbar-title">
            <h2>我的邮箱</h2>
            {PROVIDER_KIND_ORDER.map((kind) => (
              <span
                key={kind}
                className={cx("quota-chip", usage[kind] >= limits[kind] && "quota-chip-full")}
                title={`${PROVIDER_KIND_LABEL[kind]}：已用 ${usage[kind]} / 上限 ${limits[kind]}`}
              >
                {PROVIDER_KIND_SHORT[kind]} {usage[kind]} / {limits[kind]}
              </span>
            ))}
          </div>
          <div className="toolbar-right mailbox-toolbar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setImportOpen(true)}
              title={importTitle}
            >
              <Upload size={15} aria-hidden="true" />
              导入 Outlook 账号
            </button>
            {renderAcquireButton()}
          </div>
        </div>
      </section>

      {error !== null ? (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-xs" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      {loading && mailboxes.length === 0 ? (
        <div className="page-stack" role="status" aria-label="正在加载我的邮箱">
          <section className="card">
            <div className="skeleton-toolbar">
              <Skeleton width={160} height={18} />
              <Skeleton width={220} height={32} radius={10} />
            </div>
          </section>
          <div className="my-mailbox-body">
            <aside className="card mailbox-side">
              <div className="mailbox-side-head">
                <Skeleton width={90} height={16} />
              </div>
              <div className="mailbox-side-list">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} height={64} radius={12} />
                ))}
              </div>
            </aside>
            <section className="card my-mailbox-main">
              <div className="mailbox-main-skeleton">
                <Skeleton width="55%" height={22} />
                <Skeleton height={320} radius={12} />
              </div>
            </section>
          </div>
        </div>
      ) : mailboxes.length === 0 ? (
        <section className="card">
          <div className="mailbox-empty">
            <EmptyState
              icon={<Mail size={22} aria-hidden="true" />}
              title="还没有邮箱"
              description={`点「获取邮箱」：Outlook 从账号池领取、域名邮箱生成别名、临时邮箱随机生成。当前配额：Outlook ${limits.outlook}、域名邮箱 ${limits.domain}、临时邮箱 ${limits.temp}。`}
              action={renderAcquireButton()}
            />
          </div>
        </section>
      ) : (
        <div className="my-mailbox-body">
          <aside className="card mailbox-side">
            <div className="mailbox-side-head">
              <h2>邮箱列表</h2>
              <span className="cell-muted">共 {filteredMailboxes.length} 个</span>
            </div>

            <div className="mailbox-side-filters">
              <div className="segmented mailbox-tabs" role="tablist" aria-label="邮箱类型筛选">
                {TABS.map((item) => {
                  const count = item.value === "all" ? mailboxes.length : kindCounts[item.value];
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.value}
                      className={cx("segmented-item", tab === item.value && "segmented-item-active")}
                      onClick={() => setTab(item.value)}
                    >
                      {item.label}
                      <span className="mailbox-tab-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              <Select
                className="mailbox-tag-filter"
                ariaLabel="按标签筛选"
                value={tagFilter}
                onChange={setTagFilter}
                options={[
                  { value: "", label: "全部标签" },
                  ...allTags.map((tag) => ({ value: tag, label: tag })),
                ]}
              />
            </div>

            <div className="mailbox-side-list">
              {filteredMailboxes.length === 0 ? (
                <div className="mailbox-side-empty cell-muted">{emptyListText}</div>
              ) : (
                filteredMailboxes.map(renderListItem)
              )}
            </div>
          </aside>

          <section className="card my-mailbox-main">
            <div className="my-mailbox-select">
              <div className="field">
                <span className="field-label">当前邮箱</span>
                <Select
                  value={activeId ?? ""}
                  onChange={(next) => setActiveId(next)}
                  ariaLabel="当前邮箱"
                  options={mailboxes.map((item) => ({
                    value: item.id,
                    label: `${item.email}（${PROVIDER_KIND_SHORT[kindOf(item)]}）`,
                  }))}
                />
              </div>
            </div>

            {active === null ? (
              <EmptyState
                icon={<Inbox size={22} aria-hidden="true" />}
                title="选择一个邮箱"
                description="点击左侧列表里的邮箱查看对应收件箱。"
              />
            ) : (
              <>
                <div className="inbox-card-head my-mailbox-inbox-head">
                  <div className="my-mailbox-inbox-title">
                    <h2 className="card-title" title={active.email}>
                      {active.email}
                    </h2>
                    <p className="card-desc">
                      {active.providerName} · 每 10 秒自动刷新（页面隐藏时暂停）
                    </p>
                    <TagChips tags={active.tags} max={6} className="mailbox-head-tags" />
                  </div>
                  <div className="inbox-card-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setTagTarget(active)}
                    >
                      <Tag size={15} aria-hidden="true" />
                      标签
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void onCopy(active.email)}
                    >
                      <Copy size={15} aria-hidden="true" />
                      复制地址
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={refreshInbox}>
                      <RefreshCw size={15} aria-hidden="true" />
                      刷新
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-ghost-danger"
                      onClick={() => setReleaseTarget(active)}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      释放
                    </button>
                  </div>
                </div>
                <div className="my-mailbox-inbox">
                  <MailboxInboxPanel
                    key={active.id}
                    mailboxId={active.id}
                    listMessages={myMessages}
                    getMessage={myMessage}
                    pollIntervalMs={10000}
                    onDeleteMessage={handleDeleteMessage}
                    onClearInbox={handleClearInbox}
                    allowDelete={kindOf(active) !== "outlook"}
                    refreshKey={refreshKey}
                    emptyHint="还没有收到邮件。把邮箱地址用于注册后，验证码邮件会自动出现在这里。"
                  />
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <ImportMyMailboxModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(result) => {
          const parts = [`已导入 ${result.imported} 个邮箱`];
          if (result.skipped > 0) parts.push(`跳过 ${result.skipped}`);
          if (result.quotaSkipped > 0) parts.push(`配额不足 ${result.quotaSkipped}`);
          if (result.errors.length > 0) parts.push(`失败 ${result.errors.length}`);
          if (result.imported > 0) toast.success(parts.join("，"));
          else toast.error(parts.join("，"));
          reload();
          void syncSession();
        }}
      />

      <AcquireMailboxModal
        open={acquireOpen}
        remaining={remaining}
        limits={limits}
        usage={usage}
        onClose={() => setAcquireOpen(false)}
        onAcquired={onAcquired}
      />

      <TagEditorModal
        open={tagTarget !== null}
        title={`编辑标签 · ${tagTarget?.email ?? ""}`}
        tags={tagTarget?.tags ?? []}
        onClose={() => setTagTarget(null)}
        onSubmit={saveTags}
      />

      <ConfirmDialog
        open={releaseTarget !== null}
        title="释放邮箱"
        danger
        loading={releasing}
        confirmText="释放"
        message={
          <>
            确定释放邮箱「{releaseTarget?.email ?? ""}」吗？
            <br />
            释放后该地址会回到邮箱池，其他人可能领取，已收到的邮件将无法再查看。
            <br />
            <strong>注意：释放后该邮箱回到池子，但已用额度不会退回，需要管理员重置。</strong>
          </>
        }
        onCancel={() => setReleaseTarget(null)}
        onConfirm={() => void onRelease()}
      />
    </div>
  );
}
