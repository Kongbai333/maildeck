import { Clock, Globe, Mail } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { acquireMailbox, isAbortError, isUnauthorizedError, myProviders } from "../../api";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure } from "../../session";
import type {
  AcquireMailboxResult,
  ProviderKind,
  ProviderOption,
  QuotaBuckets,
} from "../../types";
import { cx, providerLabel } from "../../utils";

const KIND_ORDER: readonly ProviderKind[] = ["outlook", "domain", "temp"];

const KIND_DESC: Record<ProviderKind, string> = {
  outlook: "从 Outlook 账号池领取一个可用账号",
  domain: "由服务商生成一个域名邮箱别名",
  temp: "随机生成一个临时邮箱地址",
};

const KIND_ICON: Record<ProviderKind, ReactNode> = {
  outlook: <Mail size={20} aria-hidden="true" />,
  domain: <Globe size={20} aria-hidden="true" />,
  temp: <Clock size={20} aria-hidden="true" />,
};

const KIND_TITLE: Record<ProviderKind, string> = {
  outlook: "Outlook（从账号池领取）",
  domain: "域名邮箱（生成别名）",
  temp: "临时邮箱（随机生成）",
};

export interface AcquireMailboxModalProps {
  open: boolean;
  /** 三类剩余配额（Outlook / 域名 / 临时）= 上限 - 已用 */
  remaining: QuotaBuckets;
  /** 三类配额上限 */
  limits: QuotaBuckets;
  /** 三类已用额度 */
  usage: QuotaBuckets;
  onClose: () => void;
  onAcquired: (result: AcquireMailboxResult) => void;
}

/**
 * 统一「获取邮箱」弹窗：先选类型，再提交。
 * - Outlook：直接从账号池领取；
 * - 域名 / 临时：该类有多个服务商时显示下拉，只有一个则默认。
 */
export function AcquireMailboxModal({
  open,
  remaining,
  limits,
  usage,
  onClose,
  onAcquired,
}: AcquireMailboxModalProps): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();

  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [kind, setKind] = useState<ProviderKind>("outlook");
  const [providerId, setProviderId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setProvidersLoading(true);
    myProviders(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setProviders(list);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setProviders([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProvidersLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, open]);

  const domainProviders = useMemo(
    () => providers.filter((item) => item.kind === "domain" && item.supportsGenerate),
    [providers],
  );
  const tempProviders = useMemo(
    () => providers.filter((item) => item.kind === "temp" && item.supportsGenerate),
    [providers],
  );

  const providersOf = (value: ProviderKind): ProviderOption[] => {
    if (value === "domain") return domainProviders;
    if (value === "temp") return tempProviders;
    return [];
  };

  const disabledOf = (value: ProviderKind): boolean => {
    if (remaining[value] <= 0) return true;
    if (value === "outlook") return false;
    return providersOf(value).length === 0;
  };

  // 禁用原因：区分「余量为 0」与「没有可用服务商」，避免误显示余量 0
  const disabledReasonOf = (value: ProviderKind): string | null => {
    if (remaining[value] <= 0) {
      return `余量 0，暂不可用（上限 ${limits[value]} - 已用 ${usage[value]}）`;
    }
    if (value !== "outlook" && providersOf(value).length === 0) return "暂无可用服务商";
    return null;
  };

  // 打开时重置错误与提交状态，并挑一个有余量的类型作为默认
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setKind((prev) => (disabledOf(prev) ? (KIND_ORDER.find((item) => !disabledOf(item)) ?? prev) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 切换类型 / 服务商列表变化时，选中该类第一个可用服务商
  useEffect(() => {
    if (!open) return;
    const list = providersOf(kind);
    setProviderId((prev) => (list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, open, providers]);

  const close = (): void => {
    if (submitting) return;
    onClose();
  };

  const currentProviders = providersOf(kind);
  const selectedProvider = currentProviders.find((item) => item.id === providerId) ?? null;
  const needsProvider = kind !== "outlook" && currentProviders.length > 1;
  const canSubmit =
    !submitting &&
    !providersLoading &&
    !disabledOf(kind) &&
    (kind === "outlook" || providerId !== "");

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await acquireMailbox({
        kind,
        providerId: kind === "outlook" ? undefined : providerId,
      });
      toast.success(`已获取 ${result.mailbox.email}`);
      onAcquired(result);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "获取邮箱失败"));
      handleFailure(cause, "获取邮箱失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="获取邮箱"
      onClose={close}
      maxWidth={560}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="acquire-mailbox-form"
            className="btn btn-primary"
            disabled={!canSubmit}
          >
            {submitting ? <Spinner size={16} /> : <Mail size={16} aria-hidden="true" />}
            {submitting ? "获取中…" : "获取邮箱"}
          </button>
        </>
      }
    >
      <form id="acquire-mailbox-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="acquire-kinds" role="radiogroup" aria-label="邮箱类型">
          {KIND_ORDER.map((item) => {
            const disabled = disabledOf(item);
            const reason = disabledReasonOf(item);
            return (
              <label
                key={item}
                className={cx(
                  "acquire-kind",
                  kind === item && "acquire-kind-active",
                  disabled && "acquire-kind-disabled",
                )}
              >
                <input
                  type="radio"
                  name="acquire-kind"
                  value={item}
                  checked={kind === item}
                  disabled={disabled || submitting}
                  onChange={() => setKind(item)}
                />
                <span className="acquire-kind-icon">{KIND_ICON[item]}</span>
                <span className="acquire-kind-body">
                  <strong className="acquire-kind-title">{KIND_TITLE[item]}</strong>
                  <span className="acquire-kind-desc">{KIND_DESC[item]}</span>
                  <span className={cx("acquire-kind-quota", disabled && "acquire-kind-quota-zero")}>
                    {reason !== null
                      ? reason
                      : `剩余 ${remaining[item]}（上限 ${limits[item]} - 已用 ${usage[item]}）`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {kind !== "outlook" ? (
          providersLoading ? (
            <p className="form-hint">正在加载服务商…</p>
          ) : currentProviders.length === 0 ? (
            <div className="alert alert-warning">
              当前没有可用于{KIND_DESC[kind]}的服务商，请联系管理员在「服务商管理」里配置。
            </div>
          ) : needsProvider ? (
            <div className="field">
              <span className="field-label">服务商</span>
              <Select
                value={providerId}
                onChange={setProviderId}
                disabled={submitting}
                ariaLabel="服务商"
                options={currentProviders.map((item) => ({
                  value: item.id,
                  label: providerLabel(item.name, item.typeLabel),
                }))}
              />
            </div>
          ) : (
            <p className="form-hint">
              将使用服务商「{selectedProvider?.name ?? currentProviders[0]?.name ?? "—"}」生成地址。
            </p>
          )
        ) : (
          <p className="form-hint">Outlook 账号从管理员导入的账号池中按顺序领取，领取后归你所有。</p>
        )}
      </form>
    </Modal>
  );
}
