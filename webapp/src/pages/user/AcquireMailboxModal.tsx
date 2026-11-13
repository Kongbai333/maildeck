import { Clock, Globe, Mail } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
const MAX_ACQUIRE_COUNT = 20;

const KIND_DESC: Record<ProviderKind, string> = {
  outlook: "从 Outlook 账号池领取可用账号",
  domain: "由服务商生成域名邮箱别名",
  temp: "随机生成临时邮箱地址",
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
  const [countText, setCountText] = useState("1");
  const [progress, setProgress] = useState({ completed: 0, total: 1 });
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submitLock = useRef(false);
  const stopRequested = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopRequested.current = true; };
  }, []);

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
    if (submitLock.current) return;
    setError(null);
    setNotice(null);
    setCountText("1");
    setProgress({ completed: 0, total: 1 });
    setStopping(false);
    stopRequested.current = false;
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
  const count = Number(countText);
  const maxCount = Math.min(MAX_ACQUIRE_COUNT, Math.max(0, Math.floor(remaining[kind])));
  const countValid = Number.isInteger(count) && count >= 1 && count <= maxCount;
  const canSubmit =
    !submitting &&
    !providersLoading &&
    !disabledOf(kind) &&
    countValid &&
    (kind === "outlook" || providerId !== "");

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || submitLock.current) return;
    submitLock.current = true;
    stopRequested.current = false;
    const requested = count;
    const acquired: AcquireMailboxResult[] = [];
    let failure: { cause: unknown } | null = null;
    setError(null);
    setNotice(null);
    setStopping(false);
    setProgress({ completed: 0, total: requested });
    setSubmitting(true);
    try {
      // Each request checks current server-side quota. Serial requests avoid provider bursts.
      for (let index = 0; index < requested; index += 1) {
        if (stopRequested.current || !mounted.current) break;
        try {
          const result = await acquireMailbox({
            kind,
            providerId: kind === "outlook" ? undefined : providerId,
          });
          acquired.push(result);
          if (mounted.current) setProgress({ completed: acquired.length, total: requested });
        } catch (cause: unknown) {
          failure = { cause };
          break;
        }
      }
      if (!mounted.current) return;
      if (acquired.length > 0) onAcquired(acquired[0]);
      const left = requested - acquired.length;
      if (failure) {
        setCountText(String(Math.max(1, left)));
        setError(`本次已成功获取 ${acquired.length} / ${requested} 个，后续已停止。${errorText(failure.cause, "获取邮箱失败")}。重试前请先确认邮箱列表，避免重复获取。`);
        if (isUnauthorizedError(failure.cause)) handleFailure(failure.cause);
        if (acquired.length > 0) toast.success(`已保存本次成功获取的 ${acquired.length} 个邮箱`);
      } else if (left > 0) {
        setCountText(String(left));
        setNotice(`已停止后续获取。本次成功 ${acquired.length} 个，剩余 ${left} 个未执行。`);
        if (acquired.length > 0) toast.success(`已获取 ${acquired.length} 个邮箱`);
      } else {
        toast.success(requested === 1 ? `已获取 ${acquired[0].mailbox.email}` : `已获取 ${acquired.length} 个邮箱`);
        onClose();
      }
    } finally {
      submitLock.current = false;
      if (mounted.current) { setSubmitting(false); setStopping(false); }
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
          <button type="button" className="btn btn-ghost"
            onClick={() => {
              if (submitting) { stopRequested.current = true; setStopping(true); }
              else close();
            }} disabled={stopping}>
            {submitting ? (stopping ? "停止中…" : "停止后续") : "取消"}
          </button>
          <button
            type="submit"
            form="acquire-mailbox-form"
            className="btn btn-primary"
            disabled={!canSubmit}
          >
            {submitting ? <Spinner size={16} /> : <Mail size={16} aria-hidden="true" />}
            {submitting ? `获取中 ${progress.completed}/${progress.total}` : countValid && count > 1 ? `获取 ${count} 个邮箱` : "获取邮箱"}
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

        {notice ? <p className="form-hint" role="status">{notice}</p> : null}
        {submitting ? <p className="form-hint" role="status">
          已成功获取 {progress.completed} / {progress.total} 个。
          {stopping ? "当前请求完成后停止，不再获取后续邮箱。" : "正在按顺序获取，请稍候。"}
        </p> : null}

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
                  onChange={() => { setKind(item); setCountText("1"); setError(null); setNotice(null); }}
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

        <label className="field">
          <span className="field-label">数量</span>
          <input className="input" type="number" name="count" inputMode="numeric"
            min={1} max={Math.max(1, maxCount)} step={1} value={countText}
            onChange={(event) => setCountText(event.target.value)}
            disabled={submitting || maxCount === 0} aria-invalid={!countValid}
            aria-describedby="acquire-count-hint" />
          <span id="acquire-count-hint" className="form-hint">
            {maxCount > 0 ? `默认 1 个，本次可获取 1–${maxCount} 个（单次上限 ${MAX_ACQUIRE_COUNT} 个，当前剩余配额 ${remaining[kind]}）。` : "当前类型没有剩余配额。"}
          </span>
          {!countValid && maxCount > 0 ? <span className="form-hint" role="alert">请输入 1–{maxCount} 之间的整数。</span> : null}
        </label>
      </form>
    </Modal>
  );
}
