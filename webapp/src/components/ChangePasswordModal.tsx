import { KeyRound } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { changePassword } from "../api";
import { useApiFailure, useSession } from "../session";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
}

export function ChangePasswordModal({ open, onClose }: ChangePasswordModalProps): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();
  const { signOut } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setCurrentPassword("");
    setNewPassword("");
    setRepeatPassword("");
    setError(null);
    setSubmitting(false);
  };

  const close = (): void => {
    if (submitting) return;
    reset();
    onClose();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (currentPassword === "") {
      setError("请输入当前密码");
      return;
    }
    if (newPassword.length < 6) {
      setError("新密码至少 6 位");
      return;
    }
    if (newPassword !== repeatPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      reset();
      onClose();
      // 服务端改密后会注销该用户所有会话，这里清空本地会话并回到登录页
      toast.success("密码已修改，请重新登录");
      signOut();
    } catch (cause) {
      setError(null);
      handleFailure(cause, "修改密码失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="修改密码"
      onClose={close}
      maxWidth={440}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="change-password-form"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? <Spinner size={16} /> : <KeyRound size={16} aria-hidden="true" />}
            保存
          </button>
        </>
      }
    >
      <form id="change-password-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">当前密码</span>
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            disabled={submitting}
          />
        </label>
        <label className="field">
          <span className="field-label">新密码</span>
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="至少 6 位"
            disabled={submitting}
          />
        </label>
        <label className="field">
          <span className="field-label">确认新密码</span>
          <input
            className="input"
            type="password"
            value={repeatPassword}
            onChange={(event) => setRepeatPassword(event.target.value)}
            autoComplete="new-password"
            disabled={submitting}
          />
        </label>
      </form>
    </Modal>
  );
}
