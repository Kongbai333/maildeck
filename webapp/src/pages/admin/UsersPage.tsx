import { Ban, CheckCircle2, KeyRound, Mail, Pencil, Plus, Power, RotateCcw, Trash2, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  adminUsers,
  createUser,
  deleteUser,
  isAbortError,
  isUnauthorizedError,
  resetUserUsage,
  updateUser,
  userMailboxes,
} from "../../api";
import { ActionMenu } from "../../components/ActionMenu";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { TableSkeleton } from "../../components/Skeleton";
import { LoadingBlock, Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure, useSession } from "../../session";
import type { AdminMailboxView, AdminUserView, Role, UserStatus } from "../../types";
import {
  clampInt,
  cx,
  formatDateTime,
  MAILBOX_STATUS_LABEL,
  PROVIDER_KIND_ORDER,
  PROVIDER_KIND_SHORT,
  quotaLimits,
  ROLE_LABEL,
  USER_STATUS_LABEL,
} from "../../utils";

/* 新建用户 */

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (user: AdminUserView) => void;
}): ReactNode {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [outlookText, setOutlookText] = useState("1");
  const [domainText, setDomainText] = useState("1");
  const [tempText, setTempText] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (username.trim() === "") {
      setError("请输入用户名");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    setSubmitting(true);
    try {
      const quotas = {
        outlook: clampInt(Number.parseInt(outlookText, 10), 0, 1000),
        domain: clampInt(Number.parseInt(domainText, 10), 0, 1000),
        temp: clampInt(Number.parseInt(tempText, 10), 0, 1000),
      };
      const created = await createUser({
        username: username.trim(),
        password,
        role,
        quotas,
        mailboxQuota: quotas.outlook,
      });
      onCreated(created);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "创建用户失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="新建用户"
      onClose={submitting ? () => undefined : onClose}
      maxWidth={460}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" form="create-user-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Spinner size={16} /> : <UserPlus size={16} aria-hidden="true" />}
            创建
          </button>
        </>
      }
    >
      <form id="create-user-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">用户名</span>
          <input
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            placeholder="登录名，例如 alice"
            disabled={submitting}
          />
        </label>
        <label className="field">
          <span className="field-label">初始密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="至少 6 位"
            disabled={submitting}
          />
        </label>
        <div className="field-row">
          <div className="field">
            <span className="field-label">角色</span>
            <Select
              value={role}
              onChange={(next) => setRole(next === "admin" ? "admin" : "user")}
              disabled={submitting}
              ariaLabel="角色"
              options={[
                { value: "user", label: "普通用户" },
                { value: "admin", label: "管理员" },
              ]}
            />
          </div>
        </div>
        <div className="field-row-3">
          <label className="field">
            <span className="field-label">Outlook 配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={outlookText}
              onChange={(event) => setOutlookText(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="field">
            <span className="field-label">域名邮箱配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={domainText}
              onChange={(event) => setDomainText(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="field">
            <span className="field-label">临时邮箱配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={tempText}
              onChange={(event) => setTempText(event.target.value)}
              disabled={submitting}
            />
          </label>
        </div>
        <p className="form-hint">
          三类配额分别计数：Outlook 从邮箱池领取，域名/临时邮箱由用户自行导入或生成；管理员不受限制。
        </p>
      </form>
    </Modal>
  );
}

/* 修改配额 */

function QuotaModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserView;
  onClose: () => void;
  onSaved: (user: AdminUserView) => void;
}): ReactNode {
  const limits = quotaLimits(user.quotas, user.mailboxQuota);
  const used = user.quotaUsage ?? user.mailboxCounts ?? { outlook: user.mailboxCount, domain: 0, temp: 0 };
  const [outlookText, setOutlookText] = useState(String(limits.outlook));
  const [domainText, setDomainText] = useState(String(limits.domain));
  const [tempText, setTempText] = useState(String(limits.temp));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const quotas = {
        outlook: clampInt(Number.parseInt(outlookText, 10), 0, 1000),
        domain: clampInt(Number.parseInt(domainText, 10), 0, 1000),
        temp: clampInt(Number.parseInt(tempText, 10), 0, 1000),
      };
      const updated = await updateUser(user.id, { quotas, mailboxQuota: quotas.outlook });
      onSaved(updated);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "修改配额失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`调整配额 · ${user.username}`}
      onClose={submitting ? () => undefined : onClose}
      maxWidth={520}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" form="quota-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Spinner size={16} /> : null}
            保存
          </button>
        </>
      }
    >
      <form id="quota-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <p className="form-hint">
          当前已用：Outlook {used.outlook} 个、域名邮箱 {used.domain} 个、临时邮箱 {used.temp} 个。
          已用额度只增不减，需要清零请用「重置邮箱用量」。
        </p>
        <div className="field-row-3">
          <label className="field">
            <span className="field-label">Outlook 配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={outlookText}
              onChange={(event) => setOutlookText(event.target.value)}
              disabled={submitting}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">域名邮箱配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={domainText}
              onChange={(event) => setDomainText(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="field">
            <span className="field-label">临时邮箱配额</span>
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={tempText}
              onChange={(event) => setTempText(event.target.value)}
              disabled={submitting}
            />
          </label>
        </div>
      </form>
    </Modal>
  );
}

/* 修改角色 */

function RoleModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserView;
  onClose: () => void;
  onSaved: (user: AdminUserView) => void;
}): ReactNode {
  const [role, setRole] = useState<Role>(user.role);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await updateUser(user.id, { role });
      onSaved(updated);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "修改角色失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`修改角色 · ${user.username}`}
      onClose={submitting ? () => undefined : onClose}
      maxWidth={420}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" form="role-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Spinner size={16} /> : <Pencil size={16} aria-hidden="true" />}
            保存
          </button>
        </>
      }
    >
      <form id="role-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="field">
          <span className="field-label">角色</span>
          <Select
            value={role}
            onChange={(next) => setRole(next === "admin" ? "admin" : "user")}
            disabled={submitting}
            ariaLabel="角色"
            options={[
              { value: "user", label: "普通用户" },
              { value: "admin", label: "管理员" },
            ]}
          />
        </div>
        <p className="form-hint">管理员可以访问全部管理页面，普通用户只能领取与查看自己的邮箱。</p>
      </form>
    </Modal>
  );
}

/* 重置密码 */

function ResetPasswordModal({
  user,
  onClose,
}: {
  user: AdminUserView;
  onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (password.length < 6) {
      setError("新密码至少 6 位");
      return;
    }
    if (password !== repeat) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      await updateUser(user.id, { password });
      toast.success(`已重置 ${user.username} 的密码`);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "重置密码失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={`重置密码 · ${user.username}`}
      onClose={submitting ? () => undefined : onClose}
      maxWidth={420}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" form="reset-password-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Spinner size={16} /> : <KeyRound size={16} aria-hidden="true" />}
            重置
          </button>
        </>
      }
    >
      <form id="reset-password-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">新密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="至少 6 位"
            disabled={submitting}
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field-label">确认新密码</span>
          <input
            className="input"
            type="password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            autoComplete="new-password"
            disabled={submitting}
          />
        </label>
      </form>
    </Modal>
  );
}

/* ---------------------------- 用户持有邮箱 ---------------------------- */

function UserMailboxesModal({
  user,
  onClose,
}: {
  user: AdminUserView;
  onClose: () => void;
}): ReactNode {
  const handleFailure = useApiFailure();
  const [items, setItems] = useState<AdminMailboxView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    userMailboxes(user.id, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setItems(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "邮箱列表加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, user.id]);

  return (
    <Modal open title={`${user.username} 持有的邮箱`} onClose={onClose} maxWidth={520}>
      {loading ? (
        <LoadingBlock label="正在加载…" />
      ) : error !== null ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : items.length === 0 ? (
        <EmptyState compact title="暂无邮箱" description="该用户还没有领取任何邮箱。" />
      ) : (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="cell-strong">{item.email}</span>
              <span className="cell-muted">{item.providerName}</span>
              <Badge tone="badge-muted">{MAILBOX_STATUS_LABEL[item.status]}</Badge>
              <span className="cell-muted cell-xs">{formatDateTime(item.assignedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* -------------------------------- 页面 -------------------------------- */

type ConfirmState = { user: AdminUserView } | null;

export function UsersPage(): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();
  const { user: currentUser } = useSession();

  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [quotaUser, setQuotaUser] = useState<AdminUserView | null>(null);
  const [roleUser, setRoleUser] = useState<AdminUserView | null>(null);
  const [passwordUser, setPasswordUser] = useState<AdminUserView | null>(null);
  const [mailboxUser, setMailboxUser] = useState<AdminUserView | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [resetUser, setResetUser] = useState<AdminUserView | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const reload = useCallback(() => setRefreshToken((prev) => prev + 1), []);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    adminUsers(undefined, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setUsers(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "用户列表加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, refreshToken]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = keyword === "" ? users : users.filter((item) => item.username.toLowerCase().includes(keyword));
    return [...list].sort((left, right) => left.username.localeCompare(right.username));
  }, [query, users]);

  const setBusy = (id: string, busy: boolean): void => {
    setBusyIds((prev) => (busy ? [...prev, id] : prev.filter((item) => item !== id)));
  };

  const replaceUser = (updated: AdminUserView): void => {
    setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const toggleStatus = async (row: AdminUserView): Promise<void> => {
    setBusy(row.id, true);
    const next: UserStatus = row.status === "active" ? "disabled" : "active";
    try {
      const updated = await updateUser(row.id, { status: next });
      replaceUser(updated);
      toast.success(next === "active" ? "账号已启用" : "账号已停用");
    } catch (cause) {
      handleFailure(cause, "状态更新失败");
    } finally {
      setBusy(row.id, false);
    }
  };

  const toggleOnlinePlay = async (row: AdminUserView): Promise<void> => {
    setBusy(row.id, true);
    const next = !(row.canOnlinePlay === true);
    try {
      const updated = await updateUser(row.id, { canOnlinePlay: next });
      replaceUser(updated);
      toast.success(next ? `已为 ${row.username} 开通在线播放` : `已关闭 ${row.username} 的在线播放`);
    } catch (cause) {
      handleFailure(cause, "更新在线播放权限失败");
    } finally {
      setBusy(row.id, false);
    }
  };

  const runDelete = async (): Promise<void> => {    if (confirm === null) return;
    setConfirmLoading(true);
    try {
      await deleteUser(confirm.user.id);
      toast.success(`已删除用户 ${confirm.user.username}`);
      setConfirm(null);
      reload();
    } catch (cause) {
      handleFailure(cause, "删除用户失败");
    } finally {
      setConfirmLoading(false);
    }
  };

  const runResetUsage = async (): Promise<void> => {
    if (resetUser === null) return;
    setResetLoading(true);
    try {
      const updated = await resetUserUsage(resetUser.id);
      replaceUser(updated);
      toast.success(`已重置 ${resetUser.username} 的邮箱用量`);
      setResetUser(null);
    } catch (cause) {
      handleFailure(cause, "重置用量失败");
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="card">
        <div className="toolbar">
          <label className="search-box">
            <Users size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索用户名"
              aria-label="搜索用户名"
            />
          </label>
          <div className="toolbar-right">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={15} aria-hidden="true" />
              新建用户
            </button>
          </div>
        </div>

        {error !== null ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        {loading && users.length === 0 ? (
          <TableSkeleton rows={7} columns={7} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Users size={22} aria-hidden="true" />}
            title={users.length === 0 ? "还没有普通用户" : "没有匹配的用户"}
            description={
              users.length === 0
                ? "新建账号并设置邮箱配额，用户即可自行领取邮箱。"
                : "换个关键字试试。"
            }
            action={
              users.length === 0 ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  <Plus size={15} aria-hidden="true" />
                  新建用户
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-users">
              <colgroup>
                <col className="col-name" />
                <col className="col-role" />
                <col className="col-status" />
                <col className="col-quota" />
                <col className="col-perm" />
                <col className="col-created" />
                <col className="col-login" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-name">用户名</th>
                  <th className="col-role">角色</th>
                  <th className="col-status">状态</th>
                  <th className="col-quota">邮箱</th>
                  <th className="col-perm">在线播放</th>
                  <th className="col-created">创建时间</th>
                  <th className="col-login">最后登录</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const isSelf = row.id === currentUser.id;
                  const isBusy = busyIds.includes(row.id);
                  const limits = quotaLimits(row.quotas, row.mailboxQuota);
                  const used =
                    row.quotaUsage ?? row.mailboxCounts ?? { outlook: row.mailboxCount, domain: 0, temp: 0 };
                  return (
                    <tr key={row.id}>
                      <td className="col-name">
                        <span className="cell-stack">
                          <span className="cell-strong" title={row.username}>
                            {row.username}
                            {isSelf ? <span className="self-tag">当前账号</span> : null}
                          </span>
                          <span className="cell-muted cell-xs" title={row.id}>
                            {row.id}
                          </span>
                        </span>
                      </td>
                      <td className="col-role">
                        <Badge tone={row.role === "admin" ? "badge-primary" : "badge-muted"}>
                          {ROLE_LABEL[row.role]}
                        </Badge>
                      </td>
                      <td className="col-status">
                        <Badge tone={row.status === "active" ? "badge-success" : "badge-danger"}>
                          {row.status === "active" ? (
                            <CheckCircle2 size={12} aria-hidden="true" />
                          ) : (
                            <Ban size={12} aria-hidden="true" />
                          )}
                          {USER_STATUS_LABEL[row.status]}
                        </Badge>
                      </td>
                      <td className="col-quota">
                        <span
                          className="quota-summary"
                          title={`Outlook ${used.outlook}/${limits.outlook} · 域名邮箱 ${used.domain}/${limits.domain} · 临时邮箱 ${used.temp}/${limits.temp}`}
                        >
                          {PROVIDER_KIND_ORDER.map((kind, index) => (
                            <span key={kind}>
                              {index > 0 ? <span className="quota-dot"> · </span> : null}
                              <span
                                className={cx(
                                  "quota-summary-item",
                                  used[kind] >= limits[kind] && "quota-summary-full",
                                )}
                              >
                                {PROVIDER_KIND_SHORT[kind]} {used[kind]}/{limits[kind]}
                              </span>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="col-perm">
                        <label className="perm-toggle" title={row.role === "admin" ? "管理员默认拥有全部权限" : "开通/关闭该账号的在线播放权限"}>
                          <input
                            type="checkbox"
                            checked={row.role === "admin" || row.canOnlinePlay === true}
                            disabled={isBusy || row.role === "admin"}
                            onChange={() => void toggleOnlinePlay(row)}
                          />
                          <span>{row.role === "admin" ? "默认" : row.canOnlinePlay ? "已开通" : "未开通"}</span>
                        </label>
                      </td>
                      <td className="col-created cell-muted">{formatDateTime(row.createdAt)}</td>
                      <td className="col-login cell-muted">{formatDateTime(row.lastLoginAt)}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          {isBusy ? <Spinner size={14} /> : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setQuotaUser(row)}
                            title="编辑配额与角色"
                          >
                            编辑
                          </button>
                          <ActionMenu
                            label={`${row.username} 更多操作`}
                            items={[
                              {
                                key: "role",
                                label: "修改角色",
                                icon: <Users size={14} aria-hidden="true" />,
                                disabled: isSelf,
                                disabledReason: "不能修改当前登录账号的角色",
                                onSelect: () => setRoleUser(row),
                              },
                              {
                                key: "password",
                                label: "重置密码",
                                icon: <KeyRound size={14} aria-hidden="true" />,
                                onSelect: () => setPasswordUser(row),
                              },
                              {
                                key: "status",
                                label: row.status === "active" ? "停用账号" : "启用账号",
                                icon: <Power size={14} aria-hidden="true" />,
                                disabled: isSelf || isBusy,
                                disabledReason: isSelf ? "不能停用当前登录账号" : "操作进行中",
                                onSelect: () => void toggleStatus(row),
                              },
                              {
                                key: "mailboxes",
                                label: "查看邮箱",
                                icon: <Mail size={14} aria-hidden="true" />,
                                onSelect: () => setMailboxUser(row),
                              },
                              {
                                key: "reset",
                                label: "重置邮箱用量",
                                icon: <RotateCcw size={14} aria-hidden="true" />,
                                disabled: isBusy,
                                disabledReason: "操作进行中",
                                onSelect: () => setResetUser(row),
                              },
                              {
                                key: "delete",
                                label: "删除用户",
                                icon: <Trash2 size={14} aria-hidden="true" />,
                                danger: true,
                                disabled: isSelf,
                                disabledReason: "不能删除当前登录账号",
                                onSelect: () => setConfirm({ user: row }),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-foot">共 {users.length} 个账号</div>
      </section>

      {createOpen ? (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            toast.success(`已创建用户 ${created.username}`);
            reload();
          }}
        />
      ) : null}

      {quotaUser ? (
        <QuotaModal
          user={quotaUser}
          onClose={() => setQuotaUser(null)}
          onSaved={(updated) => {
            replaceUser(updated);
            toast.success("配额已更新");
          }}
        />
      ) : null}

      {roleUser ? (
        <RoleModal
          user={roleUser}
          onClose={() => setRoleUser(null)}
          onSaved={(updated) => {
            replaceUser(updated);
            toast.success("角色已更新");
          }}
        />
      ) : null}

      {passwordUser ? (
        <ResetPasswordModal user={passwordUser} onClose={() => setPasswordUser(null)} />
      ) : null}

      {mailboxUser ? (
        <UserMailboxesModal user={mailboxUser} onClose={() => setMailboxUser(null)} />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title="删除用户"
        danger
        loading={confirmLoading}
        confirmText="删除"
        message={
          <>
            确定删除用户「{confirm?.user.username ?? ""}」吗？
            <br />
            其持有的邮箱会自动回到邮箱池，该操作不可撤销。
          </>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runDelete()}
      />

      <ConfirmDialog
        open={resetUser !== null}
        title="重置邮箱用量"
        loading={resetLoading}
        confirmText="重置用量"
        message={
          <>
            确定把「{resetUser?.username ?? ""}」的三类已用额度清零吗？
            <br />
            清零后该用户可以重新领取对应数量的邮箱，其现有邮箱不会被删除。此操作不可撤销。
          </>
        }
        onCancel={() => setResetUser(null)}
        onConfirm={() => void runResetUsage()}
      />
    </div>
  );
}
