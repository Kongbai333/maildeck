import {
  Copy,
  FileInput,
  Inbox,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  adminMailboxes,
  assignMailbox,
  bulkMailboxes,
  deleteMailbox,
  isAbortError,
  isUnauthorizedError,
  providers as fetchProviders,
  updateAdminMailboxTags,
  updateMailbox,
} from "../../api";
import { ActionMenu } from "../../components/ActionMenu";
import type { ActionMenuItem } from "../../components/ActionMenu";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Spinner } from "../../components/Spinner";
import { TableSkeleton } from "../../components/Skeleton";
import { TagChips } from "../../components/TagChips";
import { TagEditorModal } from "../../components/TagEditorModal";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure } from "../../session";
import type {
  AdminMailboxView,
  BulkMailboxAction,
  MailboxStatus,
  ProviderKind,
  ProviderView,
} from "../../types";
import {
  copyText,
  cx,
  formatDateTime,
  MAILBOX_STATUS_LABEL,
  MAILBOX_STATUS_TONE,
  PROVIDER_KIND_SHORT,
  PROVIDER_KIND_TONE,
} from "../../utils";
import { AssignMailboxModal } from "./AssignMailboxModal";
import { BulkAssignMailboxModal } from "./BulkAssignMailboxModal";
import { GenerateMailboxModal } from "./GenerateMailboxModal";
import { ImportOutlookModal } from "./ImportOutlookModal";
import { MailboxMessagesDrawer } from "./MailboxMessagesDrawer";

type StatusFilter = "all" | MailboxStatus;

/** 邮箱池只分这三类；Outlook 池 = 微软账号池 */
type PoolKind = Extract<ProviderKind, "outlook" | "domain" | "temp">;

interface PoolDef {
  kind: PoolKind;
  label: string;
}

const POOLS: readonly PoolDef[] = [
  { kind: "outlook", label: "Outlook 账号池" },
  { kind: "domain", label: "域名邮箱池" },
  { kind: "temp", label: "临时邮箱池" },
];

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "available", label: "可用" },
  { value: "assigned", label: "已分配" },
  { value: "disabled", label: "已停用" },
];

const EMPTY_COPY: Record<PoolKind, { title: string; description: string }> = {
  outlook: {
    title: "Outlook 账号池还是空的",
    description: "从「导入 Outlook 账号」开始：导入后普通用户即可在「我的邮箱」里领取。",
  },
  domain: {
    title: "域名邮箱池还是空的",
    description: "先在「服务商管理」配置 IMAP 域名服务商，再用「生成邮箱」批量生成地址。",
  },
  temp: {
    title: "临时邮箱池还是空的",
    description: "先在「服务商管理」配置临时邮箱服务商（GPTMail / mail.tm），再用「生成邮箱」批量生成地址。",
  },
};

/**
 * 邮箱池：Outlook / 域名 / 临时 三个池子切换。
 * - 数据源统一 GET /api/admin/mailboxes?kind=outlook|domain|temp；
 * - Outlook 行：分配 / 回收 / 邮件 / 删除；域名与临时行：分配 / 回收 / 停用·启用 / 邮件 / 删除。
 */
export function MailboxesPage(): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();

  const [pool, setPool] = useState<PoolKind>("outlook");
  const [rows, setRows] = useState<AdminMailboxView[]>([]);
  const [allProviders, setAllProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  const [importOpen, setImportOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<AdminMailboxView | null>(null);
  const [messagesTarget, setMessagesTarget] = useState<AdminMailboxView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminMailboxView | null>(null);
  const [tagTarget, setTagTarget] = useState<AdminMailboxView | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 批量操作
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignError, setBulkAssignError] = useState<string | null>(null);
  // 悬浮批量条「已选 N 个」的展示数：清空时保留上一次的 N，避免淡出过程中闪成 0
  const [bulkCount, setBulkCount] = useState(0);

  const headCheckRef = useRef<HTMLInputElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const activePool = POOLS.find((item) => item.kind === pool) ?? POOLS[0];
  const isOutlookPool = pool === "outlook";

  const reload = useCallback(() => setRefreshToken((prev) => prev + 1), []);

  const load = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const data = await adminMailboxes(
        { status: statusFilter === "all" ? undefined : statusFilter, kind: pool },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRows(data);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || isAbortError(cause)) return;
      if (isUnauthorizedError(cause)) {
        handleFailure(cause);
        return;
      }
      setError(errorText(cause, "邮箱列表加载失败"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [handleFailure, pool, statusFilter]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load, refreshToken]);

  // 服务商列表（域名 / 临时池的「生成邮箱」下拉用）
  useEffect(() => {
    const controller = new AbortController();
    fetchProviders(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setAllProviders(list);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setAllProviders([]);
      });
    return () => controller.abort();
  }, [handleFailure, refreshToken]);

  const poolProviders = useMemo(
    () => allProviders.filter((item) => item.kind === pool),
    [allProviders, pool],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return rows
      .filter((row) => statusFilter === "all" || row.status === statusFilter)
      .filter((row) => {
        if (keyword === "") return true;
        const haystack = [
          row.email,
          row.domain,
          row.remark,
          row.providerName,
          row.assignedUsername ?? "",
          row.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [query, rows, statusFilter]);

  const setBusy = (id: string, busy: boolean): void => {
    setBusyIds((prev) => (busy ? [...prev, id] : prev.filter((item) => item !== id)));
  };

  // 只保留当前筛选结果里仍存在的选中项（切池 / 换筛选 / 搜索都会自动收敛）
  useEffect(() => {
    const visible = new Set(filtered.map((row) => row.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => visible.has(id));
      const unchanged =
        next.length === prev.length && next.every((id, index) => id === prev[index]);
      return unchanged ? prev : next;
    });
  }, [filtered]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = filtered.length > 0 && filtered.every((row) => selectedSet.has(row.id));
  const someSelected = selectedIds.length > 0 && !allSelected;
  const bulkVisible = selectedIds.length > 0;

  useEffect(() => {
    if (selectedIds.length > 0) setBulkCount(selectedIds.length);
  }, [selectedIds.length]);

  useEffect(() => {
    if (headCheckRef.current !== null) headCheckRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleSelectAll = (checked: boolean): void => {
    setSelectedIds(checked ? filtered.map((row) => row.id) : []);
  };

  const toggleSelect = (id: string, checked: boolean): void => {
    setSelectedIds((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((item) => item !== id),
    );
  };

  const busy = (id: string): boolean => busyIds.includes(id);

  const copyAddress = async (email: string): Promise<void> => {
    const copied = await copyText(email);
    if (copied) toast.success(`已复制：${email}`);
    else toast.error(`复制失败，请手动选中复制：${email}`);
  };

  const releaseMailbox = async (row: AdminMailboxView): Promise<void> => {
    setBusy(row.id, true);
    try {
      const updated = await assignMailbox(row.id, null);
      setRows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      toast.success("邮箱已回收");
      reload();
    } catch (cause) {
      handleFailure(cause, "回收失败");
    } finally {
      setBusy(row.id, false);
    }
  };

  const toggleStatus = async (row: AdminMailboxView): Promise<void> => {
    const disabling = row.status !== "disabled";
    setBusy(row.id, true);
    try {
      const updated = await updateMailbox(row.id, { status: disabling ? "disabled" : "available" });
      setRows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(disabling ? "邮箱已停用" : "邮箱已启用");
      reload();
    } catch (cause) {
      handleFailure(cause, disabling ? "停用失败" : "启用失败");
    } finally {
      setBusy(row.id, false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleting(true);
    try {
      await deleteMailbox(deleteTarget.id);
      toast.success("邮箱已删除");
      setDeleteTarget(null);
      reload();
    } catch (cause) {
      handleFailure(cause, "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const runBulk = async (action: BulkMailboxAction, userId?: string): Promise<boolean> => {
    if (selectedIds.length === 0) return false;
    setBulkBusy(true);
    try {
      const result = await bulkMailboxes({ action, ids: selectedIds, userId });
      const summary = `成功 ${result.affected} 个，跳过 ${result.skipped} 个`;
      if (result.affected > 0) toast.success(summary);
      else toast.error(summary);
      setSelectedIds([]);
      reload();
      return true;
    } catch (cause) {
      handleFailure(cause, "批量操作失败");
      return false;
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmBulkDelete = async (): Promise<void> => {
    const done = await runBulk("delete");
    if (done) setBulkDeleteOpen(false);
  };

  const submitBulkAssign = async (userId: string): Promise<void> => {
    setBulkAssignError(null);
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const result = await bulkMailboxes({ action: "assign", ids: selectedIds, userId });
      const summary = `成功 ${result.affected} 个，跳过 ${result.skipped} 个`;
      if (result.affected > 0) toast.success(summary);
      else toast.error(summary);
      setSelectedIds([]);
      setBulkAssignOpen(false);
      reload();
    } catch (cause) {
      setBulkAssignError(errorText(cause, "批量分配失败"));
    } finally {
      setBulkBusy(false);
    }
  };

  const moreItems = (row: AdminMailboxView): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [
      {
        key: "release",
        label: "回收邮箱",
        icon: <Undo2 size={14} aria-hidden="true" />,
        disabled: row.assignedUserId === null || busy(row.id),
        disabledReason: "该邮箱当前未分配",
        onSelect: () => void releaseMailbox(row),
      },
    ];
    if (!isOutlookPool) {
      const disabling = row.status !== "disabled";
      items.push({
        key: "toggle",
        label: disabling ? "停用邮箱" : "启用邮箱",
        icon: disabling ? (
          <PowerOff size={14} aria-hidden="true" />
        ) : (
          <Power size={14} aria-hidden="true" />
        ),
        disabled: busy(row.id),
        onSelect: () => void toggleStatus(row),
      });
    }
    items.push({
      key: "tags",
      label: "编辑标签",
      icon: <Tag size={14} aria-hidden="true" />,
      onSelect: () => setTagTarget(row),
    });
    items.push({
      key: "delete",
      label: "删除邮箱",
      danger: true,
      icon: <Trash2 size={14} aria-hidden="true" />,
      disabled: busy(row.id),
      onSelect: () => setDeleteTarget(row),
    });
    return items;
  };

  const switchPool = (next: PoolKind): void => {
    if (next === pool) return;
    setPool(next);
    setQuery("");
    setStatusFilter("all");
  };

  const primaryAction = isOutlookPool ? (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={() => setImportOpen(true)}
      title="粘贴 Outlook 账号（邮箱----密码----clientId----refreshToken）"
    >
      <FileInput size={15} aria-hidden="true" />
      导入 Outlook 账号
    </button>
  ) : (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={() => setGenerateOpen(true)}
      title={`为${activePool.label}生成新地址`}
    >
      <Sparkles size={15} aria-hidden="true" />
      生成邮箱
    </button>
  );

  return (
    <div className="page-stack">
      <section className="card">
        <div className="pool-head">
          <div className="segmented" role="tablist" aria-label="邮箱池切换">
            {POOLS.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="tab"
                aria-selected={pool === item.kind}
                className={cx("segmented-item", pool === item.kind && "segmented-item-active")}
                onClick={() => switchPool(item.kind)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="pool-head-meta">
            <h2 className="pool-title">{activePool.label}</h2>
            <span className="pool-count">共 {rows.length} 个</span>
          </div>
        </div>

        <div className="toolbar">
          <div className="segmented" role="group" aria-label="状态筛选">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={cx("segmented-item", statusFilter === tab.value && "segmented-item-active")}
                onClick={() => setStatusFilter(tab.value)}
                aria-pressed={statusFilter === tab.value}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="toolbar-right">
            <label className="search-box">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索邮箱 / 归属 / 备注"
                aria-label="搜索邮箱"
              />
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </button>
            {primaryAction}
          </div>
        </div>

        {/* 批量操作条：固定悬浮在视口底部居中，始终挂载以便做出现/消失过渡 */}
        <div
          className={cx("bulk-bar", bulkVisible && "bulk-bar-visible")}
          role="region"
          aria-label="批量操作"
          aria-hidden={!bulkVisible}
        >
          <span className="bulk-bar-count">
            已选 <strong>{bulkCount}</strong> 个
          </span>
          <div className="bulk-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setBulkAssignError(null);
                setBulkAssignOpen(true);
              }}
              disabled={bulkBusy}
            >
              <UserPlus size={15} aria-hidden="true" />
              批量分配
            </button>
            {!isOutlookPool ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void runBulk("disable")}
                  disabled={bulkBusy}
                >
                  <PowerOff size={15} aria-hidden="true" />
                  批量停用
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void runBulk("enable")}
                  disabled={bulkBusy}
                >
                  <Power size={15} aria-hidden="true" />
                  批量启用
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-ghost-danger"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={bulkBusy}
            >
              <Trash2 size={15} aria-hidden="true" />
              批量删除
            </button>
            {bulkBusy ? <Spinner size={15} /> : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm bulk-cancel"
            onClick={() => setSelectedIds([])}
            disabled={bulkBusy}
          >
            取消选择
          </button>
        </div>

        {error !== null ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        {loading && rows.length === 0 ? (
          <TableSkeleton rows={8} columns={8} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} aria-hidden="true" />}
            title={rows.length === 0 ? EMPTY_COPY[pool].title : "没有符合条件的邮箱"}
            description={rows.length === 0 ? EMPTY_COPY[pool].description : "试试切换状态筛选或清空搜索关键字。"}
            action={
              rows.length === 0 ? (
                isOutlookPool ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setImportOpen(true)}
                  >
                    <FileInput size={15} aria-hidden="true" />
                    导入 Outlook 账号
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setGenerateOpen(true)}
                  >
                    <Sparkles size={15} aria-hidden="true" />
                    生成邮箱
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                  }}
                >
                  清空筛选
                </button>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-mailboxes">
              <colgroup>
                <col className="col-check" />
                <col className="col-email" />
                <col className="col-provider" />
                <col className="col-status" />
                <col className="col-owner" />
                <col className="col-remark" />
                <col className="col-tags" />
                <col className="col-created" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      ref={headCheckRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={(event) => toggleSelectAll(event.target.checked)}
                      aria-label="全选当前列表"
                      title="全选当前列表"
                    />
                  </th>
                  <th className="col-email">邮箱地址</th>
                  <th className="col-provider">服务商 / 类型</th>
                  <th className="col-status">状态</th>
                  <th className="col-owner">归属</th>
                  <th className="col-remark">备注</th>
                  <th className="col-tags">标签</th>
                  <th className="col-created">创建时间</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const rowKind = row.kind ?? pool;
                  return (
                    <tr key={row.id} className={cx(selectedSet.has(row.id) && "row-selected")}>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          checked={selectedSet.has(row.id)}
                          onChange={(event) => toggleSelect(row.id, event.target.checked)}
                          aria-label={`选择 ${row.email}`}
                        />
                      </td>
                      <td className="col-email">
                        <span className="cell-email">
                          <span className="cell-strong" title={row.email}>
                            {row.email}
                          </span>
                          <button
                            type="button"
                            className="icon-btn icon-btn-xs"
                            onClick={() => void copyAddress(row.email)}
                            aria-label={`复制 ${row.email}`}
                            title="复制地址"
                          >
                            <Copy size={13} aria-hidden="true" />
                          </button>
                        </span>
                      </td>
                      <td className="col-provider">
                        {rowKind === "outlook" ? (
                          <span className="cell-strong">Outlook</span>
                        ) : (
                          <span className="cell-provider">
                            <span className="cell-strong" title={row.providerName}>
                              {row.providerName.trim() === "" ? "—" : row.providerName}
                            </span>
                            <Badge tone={PROVIDER_KIND_TONE[rowKind]}>
                              {PROVIDER_KIND_SHORT[rowKind]}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className="col-status">
                        <Badge tone={MAILBOX_STATUS_TONE[row.status]}>
                          {MAILBOX_STATUS_LABEL[row.status]}
                        </Badge>
                      </td>
                      <td className="col-owner" title={row.assignedUsername ?? undefined}>
                        {row.assignedUsername ?? "—"}
                      </td>
                      <td
                        className="col-remark cell-muted"
                        title={row.remark.trim() === "" ? undefined : row.remark}
                      >
                        {row.remark.trim() === "" ? "—" : row.remark}
                      </td>
                      <td className="col-tags">
                        {row.tags.length === 0 ? (
                          <span className="cell-muted">—</span>
                        ) : (
                          <TagChips tags={row.tags} max={3} />
                        )}
                      </td>
                      <td className="col-created cell-muted">{formatDateTime(row.createdAt)}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          {busy(row.id) ? <Spinner size={14} /> : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setAssignTarget(row)}
                            title="分配 / 改派"
                          >
                            分配
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setMessagesTarget(row)}
                            title="查看邮件"
                          >
                            邮件
                          </button>
                          <ActionMenu label={`${row.email} 更多操作`} items={moreItems(row)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-foot">
          共 {rows.length} 个（{activePool.label}）
          {query.trim() === "" ? "" : `，筛选出 ${filtered.length} 个`}
          {loading && rows.length > 0 ? " · 刷新中…" : ""}
        </div>
      </section>

      <ImportOutlookModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(result) => {
          const parts = [`已导入 ${result.imported} 个 Outlook 账号`];
          if (result.skipped > 0) parts.push(`跳过 ${result.skipped}`);
          if (result.errors.length > 0) parts.push(`失败 ${result.errors.length}`);
          if (result.imported > 0) toast.success(parts.join("，"));
          else toast.error(parts.join("，"));
          reload();
        }}
      />

      <GenerateMailboxModal
        open={generateOpen}
        providers={poolProviders}
        onClose={() => setGenerateOpen(false)}
        onGenerated={(count) => {
          if (count > 0) toast.success(`已生成 ${count} 个邮箱`);
          else toast.error("没有生成新邮箱");
          reload();
        }}
      />

      <AssignMailboxModal
        open={assignTarget !== null}
        mailbox={assignTarget}
        onClose={() => setAssignTarget(null)}
        onAssigned={(updated) => {
          setRows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
          toast.success("分配已更新");
          reload();
        }}
      />

      <MailboxMessagesDrawer mailbox={messagesTarget} onClose={() => setMessagesTarget(null)} />

      {tagTarget !== null ? (
        <TagEditorModal
          open
          title={`编辑标签 · ${tagTarget.email}`}
          tags={tagTarget.tags}
          onClose={() => setTagTarget(null)}
          onSubmit={async (next) => {
            await updateAdminMailboxTags(tagTarget.id, next);
            toast.success("标签已更新");
            setTagTarget(null);
            reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除邮箱"
        danger
        loading={deleting}
        confirmText="删除"
        message={
          <>
            确定删除邮箱「{deleteTarget?.email ?? ""}」吗？
            <br />
            删除后该账号记录会从池中移除，且无法恢复。
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

      <BulkAssignMailboxModal
        open={bulkAssignOpen}
        count={selectedIds.length}
        submitting={bulkBusy}
        error={bulkAssignError}
        onClose={() => setBulkAssignOpen(false)}
        onSubmit={(userId) => void submitBulkAssign(userId)}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        title="批量删除邮箱"
        danger
        loading={bulkBusy}
        confirmText="删除"
        message={
          <>
            确定删除选中的 {selectedIds.length} 个邮箱吗？
            <br />
            删除后这些账号记录会从池中移除，且无法恢复。
          </>
        }
        onCancel={() => setBulkDeleteOpen(false)}
        onConfirm={() => void confirmBulkDelete()}
      />
    </div>
  );
}
