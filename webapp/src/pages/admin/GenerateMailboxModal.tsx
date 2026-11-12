import { Plus, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { generateMailboxes, isAbortError, providerDomains } from "../../api";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { Spinner } from "../../components/Spinner";
import { errorText, useApiFailure } from "../../session";
import type { DomainEntry, ProviderView } from "../../types";
import { clampInt, providerLabel } from "../../utils";

export interface GenerateMailboxModalProps {
  open: boolean;
  providers: ProviderView[];
  onClose: () => void;
  onGenerated: (count: number) => void;
}

export function GenerateMailboxModal({
  open,
  providers,
  onClose,
  onGenerated,
}: GenerateMailboxModalProps): ReactNode {
  const handleFailure = useApiFailure();
  const [providerId, setProviderId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [domain, setDomain] = useState("");
  const [countText, setCountText] = useState("1");
  const [remark, setRemark] = useState("");
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
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
    if (!open || providerId === "") {
      setDomains([]);
      return undefined;
    }
    const controller = new AbortController();
    setDomainsLoading(true);
    setDomain("");
    providerDomains(providerId, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setDomains(list);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setDomains([]);
        handleFailure(cause, "域名列表加载失败，可留空随机生成");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDomainsLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, open, providerId]);

  const reset = (): void => {
    setPrefix("");
    setDomain("");
    setCountText("1");
    setRemark("");
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
    if (providerId === "") {
      setError("请先选择服务商");
      return;
    }
    const count = clampInt(Number.parseInt(countText, 10), 1, 20);
    setSubmitting(true);
    try {
      const result = await generateMailboxes({
        providerId,
        prefix: prefix.trim() === "" ? undefined : prefix.trim(),
        domain: domain === "" ? undefined : domain,
        count,
        remark: remark.trim() === "" ? undefined : remark.trim(),
      });
      onGenerated(result.created.length);
      reset();
      onClose();
    } catch (cause) {
      setError(errorText(cause, "生成邮箱失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="生成邮箱"
      onClose={close}
      maxWidth={520}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="generate-mailbox-form"
            className="btn btn-primary"
            disabled={submitting || providers.length === 0}
          >
            {submitting ? <Spinner size={16} /> : <Sparkles size={16} aria-hidden="true" />}
            {submitting ? "生成中…" : "开始生成"}
          </button>
        </>
      }
    >
      <form id="generate-mailbox-form" className="form-stack" onSubmit={onSubmit}>
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

        <div className="field-row">
          <label className="field">
            <span className="field-label">前缀（可留空随机）</span>
            <input
              className="input"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder="例如 inbox"
              disabled={submitting}
            />
          </label>

          <div className="field">
            <span className="field-label">域名{domainsLoading ? "（加载中…）" : ""}</span>
            <Select
              value={domain}
              onChange={setDomain}
              disabled={submitting || domainsLoading}
              ariaLabel="域名"
              emptyText="暂无可用域名（可留空随机）"
              options={[
                { value: "", label: "随机（不指定）" },
                ...domains.map((entry) => ({
                  value: entry.domain,
                  label: entry.wildcard ? `${entry.domain}（泛解析）` : entry.domain,
                })),
              ]}
            />
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-label">数量（1-20）</span>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={countText}
              onChange={(event) => setCountText(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="field">
            <span className="field-label">备注（可选）</span>
            <input
              className="input"
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              placeholder="例如：注册用"
              disabled={submitting}
            />
          </label>
        </div>

        <p className="form-hint">
          <RefreshCw size={13} aria-hidden="true" />
          生成后邮箱直接进入池中，状态为「可用」。
        </p>
        {domains.length > 0 ? (
          <p className="form-hint">
            <Plus size={13} aria-hidden="true" />
            该服务商可用域名共 {domains.length} 个。
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
