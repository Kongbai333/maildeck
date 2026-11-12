import { CheckCircle2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { importMyMailboxes } from "../../api";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { errorText } from "../../session";
import type { MyImportMailboxResult } from "../../types";

/** 单次最多 200 行（与用户侧导入契约一致） */
const MAX_LINES = 200;

export interface ImportMyMailboxModalProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: MyImportMailboxResult) => void;
}

/**
 * 用户自助导入：只支持 Outlook 账号（虚拟 kind，不是服务商），且**不占配额**。
 * 每行 `邮箱----密码----clientId----refreshToken`，也支持 3 段 `邮箱----<clientId>----<refreshToken>`。
 */
export function ImportMyMailboxModal({
  open,
  onClose,
  onImported,
}: ImportMyMailboxModalProps): ReactNode {
  const [text, setText] = useState("");
  const [result, setResult] = useState<MyImportMailboxResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setResult(null);
    setText("");
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
      const value = await importMyMailboxes({ text });
      setResult(value);
      onImported(value);
    } catch (cause) {
      setError(errorText(cause, "导入失败"));
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
              form="my-import-mailbox-form"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? <Spinner size={16} /> : <Upload size={16} aria-hidden="true" />}
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
              <span>已跳过</span>
              <strong>{result.skipped}</strong>
            </div>
            <div>
              <span>配额不足</span>
              <strong className={result.quotaSkipped > 0 ? "text-danger" : undefined}>
                {result.quotaSkipped}
              </strong>
            </div>
            <div>
              <span>校验失败</span>
              <strong className={result.errors.length > 0 ? "text-danger" : undefined}>
                {result.errors.length}
              </strong>
            </div>
          </div>
          {result.quotaSkipped > 0 ? (
            <div className="alert alert-warning">
              有 {result.quotaSkipped} 行因配额不足没有导入。
            </div>
          ) : null}
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
        <form id="my-import-mailbox-form" className="form-stack" onSubmit={onSubmit}>
          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="alert alert-warning">
            只能导入 Outlook 账号；不占用配额；格式「邮箱----密码----clientId----refreshToken」（也支持 3 段
            「邮箱----&lt;clientId&gt;----&lt;refreshToken&gt;」）。域名邮箱与临时邮箱请用「生成新地址」。
          </div>

          <label className="field">
            <span className="field-label">账号列表（每行一个）</span>
            <textarea
              className="input textarea"
              rows={10}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                "user01@outlook.com----password----clientId----refreshToken\nuser02@outlook.com----password----clientId----refreshToken"
              }
              disabled={submitting}
              spellCheck={false}
            />
          </label>

          <p className="form-hint">
            空行与 # 开头的行忽略；最多 {MAX_LINES} 行；当前有效行数 {lineCount}。
          </p>
        </form>
      )}
    </Modal>
  );
}
