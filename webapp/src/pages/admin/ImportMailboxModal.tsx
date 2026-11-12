import { CheckCircle2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { importMailboxes } from "../../api";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { Spinner } from "../../components/Spinner";
import { errorText } from "../../session";
import type { ImportMailboxResult, ProviderView } from "../../types";
import { providerLabel } from "../../utils";

export interface ImportMailboxModalProps {
  open: boolean;
  providers: ProviderView[];
  onClose: () => void;
  onImported: () => void;
}

export function ImportMailboxModal({
  open,
  providers,
  onClose,
  onImported,
}: ImportMailboxModalProps): ReactNode {
  const [providerId, setProviderId] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportMailboxResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (providers.length === 0) {
      setProviderId("");
      return;
    }
    setProviderId((prev) => (prev !== "" && providers.some((item) => item.id === prev) ? prev : providers[0].id));
  }, [open, providers]);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setText("");
      setError(null);
      setSubmitting(false);
    }
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
    if (providerId === "") {
      setError("请先选择服务商");
      return;
    }
    if (lineCount === 0) {
      setError("请粘贴至少一行邮箱地址");
      return;
    }
    setSubmitting(true);
    try {
      const value = await importMailboxes({ providerId, text });
      setResult(value);
      onImported();
    } catch (cause) {
      setError(errorText(cause, "导入失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="批量导入邮箱"
      onClose={close}
      maxWidth={620}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            {result ? "关闭" : "取消"}
          </button>
          {result ? null : (
            <button
              type="submit"
              form="import-mailbox-form"
              className="btn btn-primary"
              disabled={submitting || providers.length === 0}
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
              <span>成功</span>
              <strong className="text-success">{result.imported}</strong>
            </div>
            <div>
              <span>跳过</span>
              <strong>{result.skipped}</strong>
            </div>
            <div>
              <span>错误</span>
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
        <form id="import-mailbox-form" className="form-stack" onSubmit={onSubmit}>
          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          {providers.length === 0 ? (
            <div className="alert alert-warning">
              还没有可用服务商，请先到「服务商管理」新增一个服务商。
            </div>
          ) : null}

          <div className="field">
            <span className="field-label">服务商</span>
            <Select
              value={providerId}
              onChange={setProviderId}
              disabled={submitting || providers.length === 0}
              ariaLabel="服务商"
              emptyText="暂无可用服务商"
              options={providers.map((item) => ({
                value: item.id,
                label: providerLabel(item.name, item.typeLabel),
              }))}
            />
          </div>

          <label className="field">
            <span className="field-label">邮箱列表（每行一个）</span>
            <textarea
              className="input textarea"
              rows={10}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"abc@example.com\nxyz@example.com,备用邮箱\n# 井号开头的行会被忽略"}
              disabled={submitting}
              spellCheck={false}
            />
          </label>
          <p className="form-hint">
            支持「邮箱地址」或「邮箱地址,备注」两种写法；空行与 # 开头的行忽略；当前有效行数 {lineCount}
            （上限 2000）。
          </p>
        </form>
      )}
    </Modal>
  );
}
