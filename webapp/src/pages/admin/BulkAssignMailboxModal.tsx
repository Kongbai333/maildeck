import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { useAssignableUsers, UserSelectField } from "./UserPicker";

export interface BulkAssignMailboxModalProps {
  open: boolean;
  /** 已选邮箱数量 */
  count: number;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
  /** 提交时把所选用户 id 传给批量接口 */
  onSubmit: (userId: string) => void;
}

/** 批量分配：复用 AssignMailboxModal 的用户选择，只是目标从单个邮箱变成一批。 */
export function BulkAssignMailboxModal({
  open,
  count,
  submitting = false,
  error = null,
  onClose,
  onSubmit,
}: BulkAssignMailboxModalProps): ReactNode {
  const users = useAssignableUsers(open);
  const [userId, setUserId] = useState("");

  useEffect(() => {
    if (!open) return;
    setUserId("");
  }, [open]);

  const close = (): void => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    if (userId === "") return;
    onSubmit(userId);
  };

  return (
    <Modal
      open={open}
      title="批量分配邮箱"
      onClose={close}
      maxWidth={480}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="bulk-assign-mailbox-form"
            className="btn btn-primary"
            disabled={submitting || users.loading || userId === ""}
          >
            {submitting ? <Spinner size={16} /> : <UserPlus size={16} aria-hidden="true" />}
            批量分配
          </button>
        </>
      }
    >
      <form id="bulk-assign-mailbox-form" className="form-stack" onSubmit={handleSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="assign-target">
          <span className="cell-muted">目标邮箱</span>
          <strong>已选 {count} 个邮箱</strong>
          <span className="cell-muted">分配后这些邮箱都会归到同一个用户名下</span>
        </div>

        <UserSelectField
          users={users}
          value={userId}
          onChange={setUserId}
          disabled={submitting}
          allowUnassigned={false}
        />
      </form>
    </Modal>
  );
}
