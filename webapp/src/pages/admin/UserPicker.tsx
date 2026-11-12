import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { adminUsers, isAbortError } from "../../api";
import { Select } from "../../components/Select";
import type { SelectOption } from "../../components/Select";
import { useApiFailure } from "../../session";
import type { AdminUserView } from "../../types";

export interface AssignableUsers {
  users: AdminUserView[];
  activeUsers: AdminUserView[];
  disabledUsers: AdminUserView[];
  loading: boolean;
}

/**
 * 拉取可分配的用户（仅普通用户），单个分配与批量分配共用同一套数据与下拉。
 * open 为 true 时才请求，关闭后不保留旧数据。
 */
export function useAssignableUsers(open: boolean): AssignableUsers {
  const handleFailure = useApiFailure();
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoading(true);
    adminUsers(undefined, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setUsers(list.filter((item) => item.role === "user"));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        handleFailure(cause, "用户列表加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, open]);

  return useMemo(() => {
    return {
      users,
      activeUsers: users.filter((item) => item.status === "active"),
      disabledUsers: users.filter((item) => item.status !== "active"),
      loading,
    };
  }, [loading, users]);
}

export interface UserSelectFieldProps {
  users: AssignableUsers;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  allowUnassigned?: boolean;
  unassignedLabel?: string;
  /** 字段标签，默认「分配给」 */
  label?: string;
  /** 只列出启用用户（导入后分配等场景不展示已停用账号） */
  activeOnly?: boolean;
}

/** 用户选择下拉：与单行分配保持一致的展示（已持有 X/Y、已停用分组）。 */
export function UserSelectField({
  users,
  value,
  onChange,
  disabled = false,
  allowUnassigned = true,
  unassignedLabel = "不分配（回收邮箱）",
  label = "分配给",
  activeOnly = false,
}: UserSelectFieldProps): ReactNode {
  const { activeUsers, disabledUsers, loading, users: all } = users;

  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [];
    if (allowUnassigned) list.push({ value: "", label: unassignedLabel });
    for (const item of activeUsers) {
      list.push({
        value: item.id,
        label: `${item.username}（已持有 ${item.mailboxCount} / ${item.mailboxQuota}）`,
      });
    }
    if (!activeOnly) {
      for (const item of disabledUsers) {
        list.push({ value: item.id, label: `${item.username}（已停用）` });
      }
    }
    return list;
  }, [activeOnly, activeUsers, allowUnassigned, disabledUsers, unassignedLabel]);

  const visibleUsers = activeOnly ? activeUsers : all;

  return (
    <>
      <div className="field">
        <span className="field-label">{label}</span>
        <Select
          value={value}
          onChange={onChange}
          disabled={disabled || loading}
          ariaLabel={label}
          placeholder="请选择用户"
          emptyText="暂无普通用户"
          options={options}
        />
      </div>

      {loading ? <p className="form-hint">正在加载用户列表…</p> : null}
      {!loading && visibleUsers.length === 0 ? (
        <p className="form-hint">还没有普通用户，可先到「用户管理」新建账号。</p>
      ) : null}
    </>
  );
}
