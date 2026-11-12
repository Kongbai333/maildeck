import { Globe, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  createProvider,
  deleteProvider,
  isAbortError,
  isUnauthorizedError,
  providerDomains,
  providerTypes,
  providers as fetchProviders,
  refreshProviderKeys,
} from "../../api";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { TableSkeleton } from "../../components/Skeleton";
import { LoadingBlock, Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure } from "../../session";
import type {
  DomainEntry,
  KeyMode,
  ProviderConfigField,
  ProviderTypeView,
  ProviderView,
} from "../../types";
import { cx, PROVIDER_KIND_LABEL, PROVIDER_KIND_SHORT, PROVIDER_KIND_TONE } from "../../utils";

/* 新增服务商（v2：按 ProviderTypeView.configFields 动态渲染） */

/**
 * 「新增服务商」下拉的类型白名单：
 * - gptmail：GPTMail 临时邮箱
 * - imap：IMAP 域名邮箱
 * - yyds：YYDS Mail / 215.im 临时邮箱（支持多 Key 轮换）
 * - mailtm：mail.tm 临时邮箱（免 Key 兜底）
 * 不在白名单内的类型即使后端返回也不会出现在下拉里。
 */
const CREATE_PROVIDER_TYPES: readonly string[] = ["gptmail", "imap", "yyds", "mailtm"];

const DEFAULT_FIELDS: ProviderConfigField[] = ["baseUrl", "apiKey", "keyMode"];

function CreateProviderModal({
  types,
  onClose,
  onCreated,
}: {
  types: ProviderTypeView[];
  onClose: () => void;
  onCreated: (list: ProviderView[]) => void;
}): ReactNode {
  const [type, setType] = useState(types[0]?.type ?? "");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(types[0]?.defaultBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("public");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState("");
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = types.find((item) => item.type === type) ?? null;
  const fields = selected !== null && selected.configFields.length > 0 ? selected.configFields : DEFAULT_FIELDS;
  const has = (field: ProviderConfigField): boolean => fields.includes(field);
  const requiresKey = selected?.requiresKey ?? true;
  const keyLabel = has("host") || type === "imap" ? "密码" : "API Key";

  const onTypeChange = (next: string): void => {
    setType(next);
    const matched = types.find((item) => item.type === next);
    setBaseUrl(matched ? matched.defaultBaseUrl : "");
    setError(null);
    setHost("");
    setPort("993");
    setSecure(true);
    setUser("");
    setDomain("");
    setApiKey("");
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (type === "") {
      setError("请选择服务商类型");
      return;
    }
    if (requiresKey && apiKey.trim() === "") {
      setError(`请填写${keyLabel}`);
      return;
    }
    if (has("host") && host.trim() === "") {
      setError("请填写 IMAP 主机");
      return;
    }
    if (has("user") && user.trim() === "") {
      setError("请填写 IMAP 用户名");
      return;
    }
    if (has("domain") && domain.trim() === "") {
      setError("请填写 catch-all 域名");
      return;
    }

    const meta: Record<string, string> = {};
    if (has("host")) meta.host = host.trim();
    if (has("port")) meta.port = port.trim() === "" ? "993" : port.trim();
    if (has("secure")) meta.secure = secure ? "1" : "0";
    if (has("user")) meta.user = user.trim();
    if (has("domain")) meta.domain = domain.trim();

    setSubmitting(true);
    try {
      const trimmedKey = apiKey.trim();
      const keyLines = trimmedKey === "" ? [] : apiKey.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
      const list = await createProvider({
        type,
        name: name.trim() === "" ? undefined : name.trim(),
        baseUrl: has("baseUrl") && baseUrl.trim() !== "" ? baseUrl.trim() : undefined,
        apiKey: keyLines[0],
        // apiKeys 传「除第一把之外的其余 Key」：apiKey 与 apiKeys 会一起计入 keyCount，
        // 因此这里去掉首把避免同一把 Key 被重复计数（N 行 → keyCount = N）。
        apiKeys: type === "yyds" && keyLines.length > 1 ? keyLines.slice(1) : undefined,
        keyMode: has("keyMode") ? keyMode : undefined,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
      onCreated(list);
      onClose();
    } catch (cause) {
      setError(errorText(cause, "新增服务商失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="新增服务商"
      onClose={submitting ? () => undefined : onClose}
      maxWidth={520}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="create-provider-form"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? <Spinner size={16} /> : <Plus size={16} aria-hidden="true" />}
            保存
          </button>
        </>
      }
    >
      <form id="create-provider-form" className="form-stack" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="field-row">
          <div className="field">
            <span className="field-label">类型</span>
            <Select
              value={type}
              onChange={onTypeChange}
              disabled={submitting || types.length === 0}
              ariaLabel="服务商类型"
              emptyText="暂无可用类型"
              options={types.map((item) => ({ value: item.type, label: item.label }))}
            />
          </div>
          <label className="field">
            <span className="field-label">显示名称（可选）</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="留空则用类型名"
              disabled={submitting}
            />
          </label>
        </div>

        {selected !== null ? (
          <div className="provider-badges">
            <Badge tone={PROVIDER_KIND_TONE[selected.kind]}>
              {PROVIDER_KIND_LABEL[selected.kind]}
            </Badge>
            <span className="cell-muted cell-xs">{selected.type}</span>
          </div>
        ) : null}

        {has("baseUrl") ? (
          <label className="field">
            <span className="field-label">BaseURL</span>
            <input
              className="input"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={selected?.defaultBaseUrl ? selected.defaultBaseUrl : "选择类型后自动填充，可手动修改"}
              disabled={submitting}
            />
          </label>
        ) : null}

        {has("host") ? (
          <div className="field-row">
            <label className="field">
              <span className="field-label">IMAP 主机</span>
              <input
                className="input"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="imap.example.com"
                disabled={submitting}
              />
            </label>
            <label className="field">
              <span className="field-label">端口</span>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="993"
                disabled={submitting}
              />
            </label>
          </div>
        ) : null}

        {has("secure") ? (
          <div className="field">
            <span className="field-label">加密方式</span>
            <label className="field-check">
              <input
                type="checkbox"
                checked={secure}
                onChange={(event) => setSecure(event.target.checked)}
                disabled={submitting}
              />
              <span>SSL / TLS（993 端口建议开启）</span>
            </label>
          </div>
        ) : null}

        {has("user") ? (
          <label className="field">
            <span className="field-label">IMAP 用户名</span>
            <input
              className="input"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              placeholder="catch-all@example.com"
              autoComplete="off"
              disabled={submitting}
            />
          </label>
        ) : null}

        {has("apiKey") ? (
          <label className="field">
            <span className="field-label">
              {type === "yyds" ? "API Key（每行一把，可多把，自动轮换）" : keyLabel}
            </span>
            {type === "yyds" ? (
              <textarea
                className="input textarea"
                rows={4}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                placeholder={"AC-xxxxxxxx\nAC-yyyyyyyy"}
                disabled={submitting}
              />
            ) : (
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                placeholder={keyLabel === "密码" ? "该 IMAP 账号的密码" : "服务商提供的 API Key"}
                disabled={submitting}
              />
            )}
          </label>
        ) : null}

        {has("domain") ? (
          <label className="field">
            <span className="field-label">catch-all 域名</span>
            <input
              className="input"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="example.com"
              autoComplete="off"
              disabled={submitting}
            />
          </label>
        ) : null}

        {has("keyMode") ? (
          <fieldset className="field">
            <legend className="field-label">Key 模式</legend>
            <div className="radio-row">
              <label className={cx("radio-card", keyMode === "public" && "radio-card-active")}>
                <input
                  type="radio"
                  name="keyMode"
                  value="public"
                  checked={keyMode === "public"}
                  onChange={() => setKeyMode("public")}
                  disabled={submitting}
                />
                <span>
                  <strong>公共</strong>
                  <small>全站共用一个 Key，可定时刷新</small>
                </span>
              </label>
              <label className={cx("radio-card", keyMode === "personal" && "radio-card-active")}>
                <input
                  type="radio"
                  name="keyMode"
                  value="personal"
                  checked={keyMode === "personal"}
                  onChange={() => setKeyMode("personal")}
                  disabled={submitting}
                />
                <span>
                  <strong>个人</strong>
                  <small>使用自己申请的 Key</small>
                </span>
              </label>
            </div>
          </fieldset>
        ) : null}

        {selected?.type === "mailtm" ? (
          <p className="field-note">该类型无需 API Key：服务端会自动注册地址并保存口令。</p>
        ) : null}
        {selected?.type === "gptmail" ? (
          <p className="field-note">公共 Key 由服务端自动获取并每日刷新；也可以填自己申请的 Key。</p>
        ) : null}
        {selected?.type === "yyds" ? (
          <p className="field-note">
            每行一把 Key：服务端按顺序轮换使用，某把失效时自动切换到下一把。
          </p>
        ) : null}

        {has("host") && has("domain") ? (
          <p className="field-note">
            所有 <code>*@{domain.trim() === "" ? "域名" : domain.trim()}</code> 的邮件都从该 IMAP 账号读取；生成或导入的地址必须属于该域名。
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/* 域名预览 */

function DomainsModal({
  provider,
  onClose,
}: {
  provider: ProviderView;
  onClose: () => void;
}): ReactNode {
  const handleFailure = useApiFailure();
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    providerDomains(provider.id, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setDomains(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "域名拉取失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, provider.id, token]);

  return (
    <Modal open title={`${provider.name} · 可用域名`} onClose={onClose} maxWidth={560}>
      {loading ? (
        <LoadingBlock label="正在拉取域名…" />
      ) : error !== null ? (
        <div className="page-stack">
          <div className="alert alert-error" role="alert">
            {error}
          </div>
          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setToken((prev) => prev + 1)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              重试
            </button>
          </div>
        </div>
      ) : domains.length === 0 ? (
        <EmptyState compact title="没有可用域名" description="服务商未返回域名列表，生成邮箱时可留空随机。" />
      ) : (
        <div className="domain-panel">
          <p className="form-hint">
            共 <strong>{domains.length}</strong> 个域名
          </p>
          <div className="chips">
            {domains.map((item) => (
              <span key={item.domain} className="chip">
                <Globe size={13} aria-hidden="true" />
                {item.domain}
                {item.wildcard ? <span className="chip-tag">泛解析</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------- 页面 -------------------------------- */

type ConfirmState = { provider: ProviderView } | null;

export function ProvidersPage(): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();

  const [list, setList] = useState<ProviderView[]>([]);
  const [types, setTypes] = useState<ProviderTypeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [domainsProvider, setDomainsProvider] = useState<ProviderView | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((prev) => prev + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([fetchProviders(controller.signal), providerTypes(controller.signal)])
      .then(([providers, providerTypeList]) => {
        if (controller.signal.aborted) return;
        setList(providers);
        setTypes(providerTypeList);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setError(errorText(cause, "服务商列表加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, token]);

  const onRefreshKeys = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const result = await refreshProviderKeys();
      toast.success(`已刷新 ${result?.refreshed ?? 0} 个公共 Key`);
      reload();
    } catch (cause) {
      handleFailure(cause, "刷新公共 Key 失败");
    } finally {
      setRefreshing(false);
    }
  };

  const runDelete = async (): Promise<void> => {
    if (confirm === null) return;
    setConfirmLoading(true);
    try {
      const updated = await deleteProvider(confirm.provider.id);
      setList(updated);
      toast.success(`已删除服务商 ${confirm.provider.name}`);
      setConfirm(null);
    } catch (cause) {
      handleFailure(cause, "删除服务商失败");
    } finally {
      setConfirmLoading(false);
    }
  };

  // 新增下拉只喂白名单内的类型；types 保留全量，供表格里已有记录判断 requiresKey 使用。
  const createTypes = types.filter((item) => CREATE_PROVIDER_TYPES.includes(item.type));

  return (
    <div className="page-stack">
      <section className="card">
        <div className="toolbar">
          <div className="toolbar-left">
            <span className="cell-muted">
              共 {list.length} 个服务商 · 启用 {list.filter((item) => item.enabled).length} 个
            </span>
          </div>
          <div className="toolbar-right">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void onRefreshKeys()}
              disabled={refreshing}
            >
              {refreshing ? <Spinner size={15} /> : <RefreshCw size={15} aria-hidden="true" />}
              刷新公共 Key
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Plus size={15} aria-hidden="true" />
              新增服务商
            </button>
          </div>
        </div>

        {error !== null ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        {loading && list.length === 0 ? (
          <TableSkeleton rows={5} columns={7} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Server size={22} aria-hidden="true" />}
            title="还没有服务商"
            description="新增一个邮件服务商后，才能生成或导入邮箱。"
            action={
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                <Plus size={15} aria-hidden="true" />
                新增服务商
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-providers">
              <colgroup>
                <col className="col-name" />
                <col className="col-type" />
                <col className="col-endpoint" />
                <col className="col-key" />
                <col className="col-status" />
                <col className="col-count" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-name">名称</th>
                  <th className="col-type">类型</th>
                  <th className="col-endpoint">接入信息</th>
                  <th className="col-key">Key</th>
                  <th className="col-status">状态</th>
                  <th className="col-count">邮箱数</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((row) => {
                  const isImap = row.type === "imap";
                  const needsKey = types.find((item) => item.type === row.type)?.requiresKey ?? true;
                  const keyCount = row.keyCount > 0 ? row.keyCount : row.hasKey ? 1 : 0;
                  const multiKey = keyCount > 1;
                  const imapUser = row.meta.user ?? "";
                  const imapHost = row.meta.host ?? "";
                  const endpoint = isImap
                    ? imapUser.includes("@")
                      ? imapUser
                      : imapUser === ""
                        ? imapHost
                        : `${imapUser}@${imapHost}`
                    : row.baseUrl;
                  return (
                    <tr key={row.id}>
                      <td className="col-name cell-strong" title={row.name}>
                        {row.name}
                      </td>
                      <td className="col-type">
                        <span className="provider-type">
                          <span className="provider-type-label" title={row.typeLabel}>
                            {row.typeLabel}
                          </span>
                          <Badge tone={PROVIDER_KIND_TONE[row.kind]}>
                            {PROVIDER_KIND_SHORT[row.kind]}
                          </Badge>
                        </span>
                      </td>
                      <td className="col-endpoint">
                        <span className="cell-stack">
                          <span className="cell-muted" title={endpoint}>
                            {endpoint === "" || endpoint === "@" ? "—" : endpoint}
                          </span>
                          {isImap ? (
                            <span className="cell-muted cell-xs provider-meta" title={row.meta.domain}>
                              {row.meta.domain ?? "—"}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="col-key">
                        <span className="cell-stack">
                          {multiKey ? (
                            <Badge tone="badge-success">{keyCount} 把 Key</Badge>
                          ) : needsKey ? (
                            <Badge tone={row.hasKey ? "badge-success" : "badge-danger"}>
                              {row.hasKey ? "已配置" : "缺失"}
                            </Badge>
                          ) : (
                            <Badge tone="badge-muted">无需 Key</Badge>
                          )}
                          <span className="cell-muted cell-xs">
                            {multiKey
                              ? "自动轮换"
                              : isImap
                                ? "IMAP 密码"
                                : needsKey
                                  ? row.keyMode === "public"
                                    ? "公共"
                                    : "个人"
                                  : "免密钥"}
                          </span>
                        </span>
                      </td>
                      <td className="col-status">
                        <Badge tone={row.enabled ? "badge-success" : "badge-muted"}>
                          {row.enabled ? "启用" : "停用"}
                        </Badge>
                      </td>
                      <td className="col-count">{row.mailboxCount}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setDomainsProvider(row)}
                          >
                            <Globe size={14} aria-hidden="true" />
                            拉取域名
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn-xs icon-btn-danger"
                            onClick={() => setConfirm({ provider: row })}
                            title="删除服务商"
                            aria-label="删除服务商"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {createOpen ? (
        <CreateProviderModal
          types={createTypes}
          onClose={() => setCreateOpen(false)}
          onCreated={(updated) => {
            setList(updated);
            toast.success("服务商已新增");
          }}
        />
      ) : null}

      {domainsProvider ? (
        <DomainsModal provider={domainsProvider} onClose={() => setDomainsProvider(null)} />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title="删除服务商"
        danger
        loading={confirmLoading}
        confirmText="删除"
        message={
          <>
            确定删除服务商「{confirm?.provider.name ?? ""}」吗？
            <br />
            该服务商下仍有 {confirm?.provider.mailboxCount ?? 0} 个邮箱，删除后这些邮箱可能无法收取邮件。
          </>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}
