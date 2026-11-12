import { CheckCircle2, Copy, FileUp, Inbox, Loader2, Mail, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Settings, Tag, Trash2, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitErrorMessage } from "../error-display";
import { resolveFixedVirtualWindow } from "../fixed-virtual-window";
import type { AccountView } from "../types";
import { tagTone } from "../tag-colors";
import { accountMailStats, statusMeta } from "../ui-utils";
import { TokenGuidePanel } from "./TokenGuidePanel";

const ACCOUNT_ROW_HEIGHT = 88;
const DEFAULT_VIEWPORT_HEIGHT = 660;

export const AccountSidebar = memo(function AccountSidebar({
  accounts,
  filteredAccounts,
  selectedAccountId,
  loadingAccounts,
  accountQuery,
  statusFilter,
  groupFilter = "",
  groupOptions = [],
  onAccountQueryChange,
  onStatusFilterChange,
  onGroupFilterChange = () => undefined,
  onCreateGroup,
  onSelectAccount,
  onOpenImport,
  onImportFromFile,
  onReloadAccounts,
  onOpenSettings,
  showBrand = true,
  showSettingsButton = true,
  newMailCounts,
  busyAccountIds,
  refreshDisabled = false,
  onRefreshAccount,
  onTestAccount,
  onEditAccount,
  onDeleteAccount,
  onToast,
  selectedAccountError
}: {
  accounts: readonly AccountView[];
  filteredAccounts: readonly AccountView[];
  selectedAccountId: string | null;
  loadingAccounts: boolean;
  accountQuery: string;
  statusFilter: "all" | "valid" | "invalid" | "untested";
  groupFilter?: string;
  groupOptions?: readonly string[];
  onAccountQueryChange: (value: string) => void;
  onStatusFilterChange: (value: "all" | "valid" | "invalid" | "untested") => void;
  onGroupFilterChange?: (value: string) => void;
  onCreateGroup?: () => void;
  onSelectAccount: (accountId: string) => void;
  onOpenImport: () => void;
  onImportFromFile: () => void;
  onReloadAccounts: () => void;
  onOpenSettings: () => void;
  showBrand?: boolean;
  showSettingsButton?: boolean;
  newMailCounts?: Record<string, number>;
  busyAccountIds?: ReadonlySet<string>;
  refreshDisabled?: boolean;
  onRefreshAccount: (accountId: string) => void;
  onTestAccount?: (accountId: string) => void;
  onEditAccount?: (account: AccountView) => void;
  onDeleteAccount?: (account: AccountView) => void;
  onToast?: (message: string) => void;
  /** 当前选中账号读邮件失败时的原因：侧栏不能一边显示 ✓ 可用一边读不出邮件。 */
  selectedAccountError?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ account: AccountView; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  async function copyContextValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      onToast?.(`${label}已复制`);
    } catch {
      onToast?.(`复制${label}失败`);
    }
    setContextMenu(null);
  }

  // Ctrl+F / Cmd+F 把焦点导到侧栏搜索框，替代浏览器默认查找。放本组件内
  // 而不是 App，是为了让搜索框与其焦点行为内聚、可独立测试。
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        const input = searchInputRef.current;
        if (!input) {
          return;
        }
        event.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const virtualWindow = resolveFixedVirtualWindow({
    itemCount: filteredAccounts.length,
    itemHeight: ACCOUNT_ROW_HEIGHT,
    scrollTop,
    viewportHeight
  });
  const visibleAccounts = useMemo(
    () => filteredAccounts.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [filteredAccounts, virtualWindow.startIndex, virtualWindow.endIndex]
  );
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      if (account.group) {
        counts.set(account.group, (counts.get(account.group) ?? 0) + 1);
      }
    }
    return counts;
  }, [accounts]);

  const hasAccounts = accounts.length > 0;

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (!scrollArea) {
      return;
    }

    const measure = () => {
      if (scrollArea.clientHeight > 0) {
        setViewportHeight(scrollArea.clientHeight);
      }
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(scrollArea);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea && scrollArea.scrollTop !== virtualWindow.scrollTop) {
      scrollArea.scrollTop = virtualWindow.scrollTop;
      setScrollTop(virtualWindow.scrollTop);
    }
  }, [virtualWindow.scrollTop]);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea) {
      scrollArea.scrollTop = 0;
    }
    setScrollTop(0);
  }, [accountQuery, statusFilter, groupFilter]);

  return (
    <aside className="sidebar">
      {showBrand ? (
        <div className="brand-block">
          <div className="brand-icon">
            <Mail size={26} />
          </div>
          <div>
            <h1>MailDeck</h1>
            <p>本地优先的邮箱工作台</p>
          </div>
        </div>
      ) : null}

      <div className="sidebar-actions">
        <button className="import-button" onClick={onOpenImport}>
          <Plus size={16} />
          导入
        </button>
        <button className="square-button" onClick={onImportFromFile} title="从文件导入（.txt / .csv）" aria-label="从文件导入账号（.txt / .csv）">
          <FileUp size={16} />
        </button>
        {/* 这个按钮只是从本地库重读列表，不是重新测试账号；名字和反馈都得说清楚（P10） */}
        <button
          className="square-button"
          onClick={onReloadAccounts}
          title="重新加载账号列表（不重新测试）"
          aria-label="重新加载账号列表"
        >
          <RefreshCw size={16} />
        </button>
        {showSettingsButton ? (
          <button className="square-button" onClick={onOpenSettings} title="设置" aria-label="打开设置">
            <Settings size={16} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-search">
        <Search size={16} />
        <input
          ref={searchInputRef}
          value={accountQuery}
          onChange={(event) => onAccountQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && accountQuery) {
              event.preventDefault();
              onAccountQueryChange("");
            }
          }}
          placeholder="搜索邮箱"
          aria-label="搜索邮箱账号"
        />
        {accountQuery ? (
          <button
            type="button"
            className="search-clear"
            onClick={() => onAccountQueryChange("")}
            title="清除搜索"
            aria-label="清除搜索"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-group-tabs-wrap">
        <div className="sidebar-group-tabs" role="tablist" aria-label="邮箱分组">
          <button
            type="button"
            role="tab"
            aria-selected={!groupFilter}
            className={`sidebar-group-tab ${!groupFilter ? "active" : ""}`}
            onClick={() => onGroupFilterChange("")}
          >
            全部 <em>{accounts.length}</em>
          </button>
          {groupOptions.map((group) => (
            <button
              type="button"
              role="tab"
              key={group}
              aria-selected={groupFilter === group}
              className={`sidebar-group-tab ${groupFilter === group ? "active" : ""}`}
              onClick={() => onGroupFilterChange(group)}
            >
              {group} <em>{groupCounts.get(group) ?? 0}</em>
            </button>
          ))}
          <button
            type="button"
            className="sidebar-group-add"
            title="新建分组"
            aria-label="新建分组"
            onClick={onCreateGroup}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`account-scroll ${!loadingAccounts && !hasAccounts ? "account-scroll-empty" : ""}`}
        aria-busy={loadingAccounts}
        aria-label="邮箱账号"
        role="region"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {loadingAccounts ? (
          <div className="panel-empty account-scroll-state">
            <Loader2 size={22} className="spin" />
            <p>加载账号</p>
          </div>
        ) : null}

        {!loadingAccounts && filteredAccounts.length === 0 ? (
          <div className="panel-empty account-scroll-state">
            <Inbox size={24} />
            {accounts.length === 0 ? (
              <>
                <p>还没有导入任何邮箱</p>
                <p className="panel-empty-hint">
                  粘贴 refresh_token，或用左上角的「从文件导入」按钮上传 .txt / .csv，就能开始读取邮件。
                </p>
                <button type="button" className="panel-error-retry" onClick={onOpenImport}>
                  导入第一个账号
                </button>
                <TokenGuidePanel className="empty-state-guide" />
              </>
            ) : (
              <>
                <p>没有符合条件的邮箱</p>
                <button
                  type="button"
                  className="panel-error-retry"
                  onClick={() => {
                    onAccountQueryChange("");
                    onStatusFilterChange("all");
                    onGroupFilterChange("");
                  }}
                >
                  清除筛选
                </button>
              </>
            )}
          </div>
        ) : null}

        {filteredAccounts.length > 0 ? (
          <div className="account-virtual-space" style={{ height: virtualWindow.totalHeight }}>
            <div className="account-virtual-window" style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}>
              {visibleAccounts.map((account, visibleIndex) => {
                const meta = statusMeta(account);
                const StatusIcon = meta.icon;
                const newCount = newMailCounts?.[account.id] || 0;
                const isRefreshing = busyAccountIds?.has(account.id) || false;
                const accountIndex = virtualWindow.startIndex + visibleIndex;

                return (
                  <div
                    key={account.id}
                    className={`account-row ${account.id === selectedAccountId ? "selected" : ""}`}
                    data-account-index={accountIndex}
                    role="button"
                    tabIndex={0}
                    title={`${account.email}${account.remark ? ` · ${account.remark}` : ""}`}
                    onClick={() => onSelectAccount(account.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setContextMenu({ account, x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectAccount(account.id);
                      }
                    }}
                  >
                    <div className="account-text">
                      <strong>{account.email}</strong>
                      <div className="account-meta-row">
                        {account.remark ? <span className="account-remark">{account.remark}</span> : null}
                        <span className={`account-stats ${account.status === "invalid" && !account.lastRefreshedAt ? "account-stats-failed" : ""}`}>
                          {accountMailStats(account)}
                        </span>
                        {account.id === selectedAccountId && selectedAccountError ? (
                          <span className="account-load-error" title={selectedAccountError}>
                            读取失败
                          </span>
                        ) : null}
                      </div>
                      {account.group || (account.tags?.length ?? 0) > 0 ? (
                        <div className="account-tag-row">
                          {account.group ? <span className="account-group-chip">{account.group}</span> : null}
                          {(account.tags ?? []).slice(0, 2).map((tag) => (
                            <span className={`account-tag-chip tag-tone-${tagTone(tag)}`} key={tag}>{tag}</span>
                          ))}
                          {(account.tags?.length ?? 0) > 2 ? (
                            <span className="account-tag-more">+{(account.tags?.length ?? 0) - 2}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="account-badges">
                      {newCount > 0 ? <span className="new-mail-chip">+{newCount}</span> : null}
                      <button
                        type="button"
                        className="account-more-button"
                        title="更多操作"
                        aria-label={`${account.email} 的更多操作`}
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setContextMenu({ account, x: rect.right - 4, y: rect.bottom + 4 });
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      <button
                        type="button"
                        className={`${meta.className} account-refresh-status`}
                        title={
                          account.lastError
                            ? `${meta.label}：${splitErrorMessage(account.lastError).title}（点击重新刷新）`
                            : `${meta.label}，点击刷新账号`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          onRefreshAccount(account.id);
                        }}
                        aria-label={
                          account.lastError
                            ? `${meta.label}：${splitErrorMessage(account.lastError).title}（点击重新刷新）`
                            : `${meta.label}，点击刷新账号`
                        }
                        disabled={refreshDisabled || isRefreshing}
                      >
                        {isRefreshing ? <Loader2 size={12} className="spin" /> : <StatusIcon size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="account-context-menu"
          role="menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 230),
            top: Math.min(contextMenu.y, window.innerHeight - 340)
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu-label">{contextMenu.account.email}</div>
          <button type="button" role="menuitem" onClick={() => {
            setContextMenu(null);
            onSelectAccount(contextMenu.account.id);
          }}>
            <Mail size={14} /> 打开邮箱
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setContextMenu(null);
            onTestAccount?.(contextMenu.account.id);
          }}>
            <CheckCircle2 size={14} /> 测试连接
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setContextMenu(null);
            onRefreshAccount(contextMenu.account.id);
          }}>
            <RefreshCw size={14} /> 刷新邮件
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setContextMenu(null);
            onEditAccount?.(contextMenu.account);
          }}>
            <Pencil size={14} /> 编辑账号
          </button>
          <div className="context-menu-divider" />
          <button type="button" role="menuitem" onClick={() => void copyContextValue(contextMenu.account.email, "邮箱地址")}>
            <Copy size={14} /> 复制邮箱地址
          </button>
          {contextMenu.account.group ? (
            <button type="button" role="menuitem" onClick={() => void copyContextValue(contextMenu.account.group, "分组")}>
              <Tag size={14} /> 复制分组
            </button>
          ) : null}
          {(contextMenu.account.tags?.length ?? 0) > 0 ? (
            <button type="button" role="menuitem" onClick={() => void copyContextValue((contextMenu.account.tags ?? []).join(", "), "标签")}>
              <Tag size={14} /> 复制标签
            </button>
          ) : null}
          <div className="context-menu-divider" />
          <button type="button" role="menuitem" className="context-menu-danger" onClick={() => {
            setContextMenu(null);
            onDeleteAccount?.(contextMenu.account);
          }}>
            <Trash2 size={14} /> 删除账号
          </button>
        </div>
      ) : null}
    </aside>
  );
});
