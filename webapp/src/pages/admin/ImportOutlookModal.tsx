import { CheckCircle2, FileInput } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { importOutlookAccounts } from "../../api";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { errorText } from "../../session";
import type { ImportOutlookResult } from "../../types";
import { useAssignableUsers, UserSelectField } from "./UserPicker";

/** 单次最多 2000 行（与桌面端导入一致） */
const MAX_LINES = 2000;

export interface ImportOutlookModalProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: ImportOutlookResult) => void;
}

/**
 * Outlook 账号导入：Outlook 是虚拟 kind（数据来自微软账号表，不是服务商）。
 * 每行 `邮箱----密码----clientId----refreshToken`，可选第五段备注。
 */
export function ImportOutlookModal({ open, onClose, onImported }: ImportOutlookModalProps): ReactNode {
  const users = useAssignableUsers(open);
  const [text, setText] = useState("");
  const [userId, setUserId] = useState("");
  const [result, setResult] = useState<ImportOutlookResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setResult(null);
    setText("");
    setUserId("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  const lineCount = useMemo(
    () =>
      text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#")).length,
    [text],
  );

  const close = (): void => {
    if (submitting) return;
    onClose();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (lineCount === 0) {
      setError("请粘贴至少一行 Outlook 账号");
      return;
    }
    if (lineCount > MAX_LINES) {
      setError(`单次最多 ${MAX_LINES} 行，当前 ${lineCount} 行`);
      return;
    }
    setSubmitting(true);
    try {
      const value = await importOutlookAccounts({
        text,
        userId: userId === "" ? undefined : userId,
      });
      setResult(value);
      onImported(value);
    } catch (cause) {
      setError(errorText(cause, "导入 Outlook 账号失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="导入 Outlook 账号"
      onClose={close}
      maxWidth={680}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            {result ? "关闭" : "取消"}
          </button>
          {result ? null : (
            <button
              type="submit"
              form="import-outlook-form"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? <Spinner size={16} /> : <FileInput size={16} aria-hidden="true" />}
              {submitting ? "导入中…" : "开始导入"}
            </button>
          )}
        </>
      }
    >
      {result ? (
        <div className="import-result">
          <div className="import-result-head">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>导入完成</span>
          </div>
          <div className="import-result-stats">
            <div>
              <span>成功导入</span>
              <strong className="text-success">{result.imported}</strong>
            </div>
            <div>
              <span>已分配</span>
              <strong className={result.assigned > 0 ? "text-success" : undefined}>
                {result.assigned ?? 0}
              </strong>
            </div>
            <div>
              <span>已跳过</span>
              <strong>{result.skipped}</strong>
            </div>
            <div>
              <span>校验失败</span>
              <strong className={result.errors.length > 0 ? "text-danger" : undefined}>
                {result.errors.length}
              </strong>
            </div>
          </div>
          {result.errors.length > 0 ? (
            <ul className="import-result-errors">
              {result.errors.slice(0, 30).map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
              {result.errors.length > 30 ? (
                <li className="cell-muted">…共 {result.errors.length} 条错误</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : (
        <form id="import-outlook-form" className="form-stack" onSubmit={onSubmit}>
          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="alert alert-warning">
            Outlook 账号是邮箱池的唯一来源：导入后普通用户可在「我的邮箱」领取；临时邮箱与域名邮箱由用户自助生成，不进池。
          </div>

          <label className="field">
            <span className="field-label">账号列表（每行一个）</span>
            <textarea
              className="input textarea"
              rows={11}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                "user01@outlook.com----password----clientId----refreshToken\nuser02@outlook.com----password----clientId----refreshToken----备注"
              }
              disabled={submitting}
              spellCheck={false}
            />
          </label>

          <p className="form-hint">
            格式：邮箱----密码----clientId----refreshToken，可选第五段备注；空行与 # 开头的行忽略；当前有效行数{" "}
            {lineCount}（上限 {MAX_LINES}）。
          </p>

          <div className="import-assign">
            <UserSelectField
              users={users}
              value={userId}
              onChange={setUserId}
              disabled={submitting}
              activeOnly
              label="分配给（可选）"
              unassignedLabel="不分配（留在账号池）"
            />
            <p className="form-hint">
              不选择则导入后留在 Outlook 账号池，等用户自己领取。
            </p>
          </div>
        </form>
      )}
    </Modal>
  );
}
