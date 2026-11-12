import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { assignMailbox } from "../../api";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { errorText } from "../../session";
import type { AdminMailboxView } from "../../types";
import { useAssignableUsers, UserSelectField } from "./UserPicker";

export interface AssignMailboxModalProps {
  open: boolean;
  mailbox: AdminMailboxView | null;
  onClose: () => void;
  onAssigned: (mailbox: AdminMailboxView) => void;
}

export function AssignMailboxModal({
  open,
  mailbox,
  onClose,
  onAssigned,
}: AssignMailboxModalProps): ReactNode {
  const users = useAssignableUsers(open);
  const [userId, setUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUserId(mailbox?.assignedUserId ?? "");
    setError(null);
  }, [mailbox, open]);

  const close = (): void => {
    if (submitting) return;
    onClose();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || mailbox === null) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await assignMailbox(mailbox.id, userId === "" ? null : userId);
      onAssigned(updated);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "分配失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="分配邮箱"
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
            form="assign-mailbox-form"
            className="btn btn-primary"
            disabled={submitting || users.loading}
          >
            {submitting ? <Spinner size={16} /> : <UserPlus size={16} aria-hidden="true" />}
            保存
          </button>
        </>
      }
    >
      <form id="assign-mailbox-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="assign-target">
          <span className="cell-muted">目标邮箱</span>
          <strong>{mailbox?.email ?? "—"}</strong>
          <span className="cell-muted">
            {mailbox?.providerName ?? ""}
            {mailbox?.assignedUsername ? ` · 当前归属 ${mailbox.assignedUsername}` : " · 当前未分配"}
          </span>
        </div>

        <UserSelectField users={users} value={userId} onChange={setUserId} disabled={submitting} />
      </form>
    </Modal>
  );
}
