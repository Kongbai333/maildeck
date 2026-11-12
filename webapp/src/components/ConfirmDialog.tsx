import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      maxWidth={440}
      closeOnBackdrop={!loading}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={loading}>
            {cancelText}
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <Spinner size={16} /> : null}
            {confirmText}
          </button>
        </>
      }
    >
      <div className="confirm-body">
        <span className={danger ? "confirm-icon confirm-icon-danger" : "confirm-icon"}>
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <div className="confirm-text">{message}</div>
      </div>
    </Modal>
  );
}
