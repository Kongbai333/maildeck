import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Copy,
  Globe2,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Plus,
  RefreshCw,
  Server,
  Trash2
} from "lucide-react";
import { errorMessage } from "../app-error";
import { buildMailHtmlDocument, isMailHtmlBody, sanitizeMailHtmlDetailed } from "../mail-content-security";
import { formatDate, senderLabel } from "../ui-utils";
import type { MailMessageSummary } from "../types";
import {
  domainApi,
  type DomainCatalogEntry,
  type DomainMailboxView,
  type DomainMessageDetail,
  type DomainProviderType,
  type DomainProviderView
} from "../domain-api";
import { ModalShell } from "./ModalShell";
import { AppSelect } from "./AppSelect";

function AddProviderDialog({
  types,
  onClose,
  onCreated
}: {
  types: DomainProviderType[];
  onClose: () => void;
  onCreated: (providers: DomainProviderView[]) => void;
}) {
  const [type, setType] = useState(types[0]?.type ?? "gptmail");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(types[0]?.defaultBaseUrl ?? "https://mail.chatgpt.org.uk");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState("");
  const [keyMode, setKeyMode] = useState<"public" | "personal">("public");

  // 打开弹窗即自动取当日公共 Key，免去每次启动手工配置。
  useEffect(() => {
    let active = true;
    setKeyBusy(true);
    void domainApi
      .fetchPublicKey(types[0]?.type ?? "gptmail", types[0]?.defaultBaseUrl)
      .then((info) => {
        if (!active) {
          return;
        }
        setApiKey(info.key);
        setKeyMode("public");
        setKeyNote(
          info.isActive
            ? `已自动获取今日公共 Key，剩余 ${info.remainingToday}/${info.dailyLimit} 次（每日重置）。`
            : "已获取公共 Key，但今日额度已用完，可改用个人 Key。"
        );
      })
      .catch((fetchError) => {
        if (active) {
          setKeyNote(errorMessage(fetchError));
        }
      })
      .finally(() => {
        if (active) {
          setKeyBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [types]);

  function selectType(next: string) {
    setType(next);
    const preset = types.find((item) => item.type === next);
    if (preset) {
      setBaseUrl(preset.defaultBaseUrl);
    }
    setKeyNote("");
  }

  async function autoFetchKey() {
    setKeyBusy(true);
    setKeyNote("");
    setError("");
    try {
      const info = await domainApi.fetchPublicKey(type, baseUrl);
      setApiKey(info.key);
      setKeyMode("public");
      setKeyNote(
        info.isActive
          ? `已获取公共 Key，今日剩余 ${info.remainingToday}/${info.dailyLimit} 次（共享额度，每日重置）。`
          : `已获取公共 Key，但今日额度已用完（剩余 ${info.remainingToday}），需等待每日重置或改用个人 Key。`
      );
    } catch (fetchError) {
      setKeyNote(errorMessage(fetchError));
    } finally {
      setKeyBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError("请填写 API Key");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const providers = await domainApi.createProvider({ name, type, baseUrl, apiKey, keyMode });
      onCreated(providers);
      onClose();
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="添加域名邮箱服务商"
      subtitle="配置 API 后即可生成临时邮箱并收取邮件"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button dark-primary" disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 添加服务商
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          服务商类型
          <AppSelect
            value={type}
            onChange={selectType}
            ariaLabel="服务商类型"
            options={types.map((item) => ({ value: item.type, label: item.label }))}
          />
        </label>
        <label>
          名称（可选）
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：GPTMail 主号" />
        </label>
        <label className="span-2">
          API 基础地址
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label className="span-2">
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setKeyMode("personal");
            }}
            placeholder="X-API-Key，可自动获取公共 Key 或手动填写个人 Key"
            autoComplete="off"
          />
        </label>
        <div className="span-2 domain-key-actions">
          <button type="button" className="secondary-button dark-button" onClick={() => void autoFetchKey()} disabled={keyBusy}>
            {keyBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 自动获取公共 Key
          </button>
          {keyNote ? <span className="field-hint">{keyNote}</span> : null}
        </div>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
    </ModalShell>
  );
}

function GenerateMailboxDialog({
  providers,
  onClose,
  onGenerated
}: {
  providers: DomainProviderView[];
  onClose: () => void;
  onGenerated: (mailboxes: DomainMailboxView[]) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [prefix, setPrefix] = useState("");
  const [domain, setDomain] = useState("");
  const [remark, setRemark] = useState("");
  const [domains, setDomains] = useState<DomainCatalogEntry[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!providerId) {
      return;
    }
    let active = true;
    setDomainsLoading(true);
    domainApi
      .providerDomains(providerId)
      .then((list) => {
        if (active) {
          setDomains(list);
        }
      })
      .catch(() => {
        if (active) {
          setDomains([]);
        }
      })
      .finally(() => {
        if (active) {
          setDomainsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [providerId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!providerId) {
      setError("请先添加并选择一个服务商");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const mailboxes = await domainApi.generateMailbox({ providerId, prefix, domain, remark });
      onGenerated(mailboxes);
      onClose();
    } catch (generateError) {
      setError(errorMessage(generateError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="生成域名邮箱"
      subtitle="留空则随机生成；也可指定前缀和域名"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button dark-primary" disabled={busy || !providerId}>
            {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 生成邮箱
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="span-2">
          服务商
          <AppSelect
            value={providerId}
            onChange={setProviderId}
            ariaLabel="服务商"
            options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
          />
        </label>
        <label>
          前缀（可选）
          <input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="@ 前的名称" />
        </label>
        <label>
          域名（可选）
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder={domainsLoading ? "加载域名中…" : "留空随机选择"}
            list="domain-mailbox-domains"
          />
          <datalist id="domain-mailbox-domains">
            {domains.slice(0, 200).map((entry) => (
              <option key={entry.domain} value={entry.domain} />
            ))}
          </datalist>
        </label>
        <label className="span-2">
          备注（可选）
          <input value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="例如：注册 X 用" />
        </label>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
    </ModalShell>
  );
}

function DomainReader({
  detail,
  loading,
  error,
  onRetry,
  onDelete
}: {
  detail: DomainMessageDetail | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(false);
  const isHtml = detail ? isMailHtmlBody(detail.body.contentType) : false;
  const sanitized = useMemo(
    () => (isHtml ? sanitizeMailHtmlDetailed(detail?.body.content ?? "", { allowRemoteImages: showImages }) : null),
    [isHtml, detail?.body.content, showImages]
  );
  const document = useMemo(
    () => (sanitized ? buildMailHtmlDocument(sanitized.html, { allowRemoteImages: showImages }) : ""),
    [sanitized, showImages]
  );

  useEffect(() => {
    setShowImages(false);
  }, [detail?.id]);

  if (loading) {
    return <div className="panel-empty"><Loader2 size={22} className="spin" /><p>正在读取邮件</p></div>;
  }
  if (error) {
    return (
      <div className="panel-empty panel-error">
        <AlertTriangle size={24} />
        <p>邮件读取失败</p>
        <p className="panel-error-title">{error}</p>
        <button type="button" className="panel-error-retry" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (!detail) {
    return <div className="panel-empty"><Mail size={26} /><p>选择一封邮件查看正文</p></div>;
  }

  return (
    <article className="reader-panel domain-reader">
      <header className="domain-reader-header">
        <h2>{detail.subject}</h2>
        <div className="domain-reader-meta">
          <span>{senderLabel(detail)}</span>
          <span>{formatDate(detail.receivedDateTime)}</span>
        </div>
        <div className="domain-reader-actions">
          {isHtml && sanitized && sanitized.blockedImages > 0 && !showImages ? (
            <button type="button" className="secondary-button dark-button" onClick={() => setShowImages(true)}>
              显示图片（{sanitized.blockedImages}）
            </button>
          ) : null}
          <button type="button" className="secondary-button dark-button" onClick={onDelete}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      </header>
      <div className="domain-reader-body">
        {isHtml ? (
          <iframe
            ref={frameRef}
            title="邮件正文"
            className="domain-reader-frame"
            sandbox="allow-popups allow-same-origin"
            srcDoc={document}
            onLoad={() => {
              const frame = frameRef.current;
              const body = frame?.contentDocument?.body;
              if (frame && body) {
                frame.style.height = `${Math.max(200, body.scrollHeight + 24)}px`;
              }
            }}
          />
        ) : (
          <pre className="domain-reader-text">{detail.body.content}</pre>
        )}
        {detail.attachments.length > 0 ? (
          <div className="domain-reader-attachments">
            <strong><Paperclip size={14} /> 附件（{detail.attachments.length}）</strong>
            {detail.attachments.map((attachment) => (
              <div key={attachment.id} className="domain-attachment-row">
                <span>{attachment.filename}</span>
                <em>{attachment.contentType}</em>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function DomainMailboxView() {
  const [providerTypes, setProviderTypes] = useState<DomainProviderType[]>([]);
  const [providers, setProviders] = useState<DomainProviderView[]>([]);
  const [mailboxes, setMailboxes] = useState<DomainMailboxView[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessageSummary[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DomainMessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [notice, setNotice] = useState("");
  const detailRequest = useRef(0);

  const selectedMailbox = useMemo(
    () => mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? null,
    [mailboxes, selectedMailboxId]
  );

  const loadCatalog = useCallback(async () => {
    try {
      const [types, providerList, mailboxList] = await Promise.all([
        domainApi.providerTypes(),
        domainApi.providers(),
        domainApi.mailboxes()
      ]);
      setProviderTypes(types);
      setProviders(providerList);
      setMailboxes(mailboxList);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const loadMessages = useCallback(async (mailboxId: string) => {
    setMessagesLoading(true);
    setMessagesError("");
    try {
      const list = await domainApi.messages(mailboxId);
      setMessages(list);
    } catch (error) {
      setMessages([]);
      setMessagesError(errorMessage(error));
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelectedMessageId(null);
    setDetail(null);
    setDetailError("");
    if (selectedMailboxId) {
      void loadMessages(selectedMailboxId);
    } else {
      setMessages([]);
    }
  }, [selectedMailboxId, loadMessages]);

  const loadDetail = useCallback(async (mailboxId: string, messageId: string) => {
    const token = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError("");
    try {
      const result = await domainApi.message(mailboxId, messageId);
      if (token === detailRequest.current) {
        setDetail(result);
      }
    } catch (error) {
      if (token === detailRequest.current) {
        setDetail(null);
        setDetailError(errorMessage(error));
      }
    } finally {
      if (token === detailRequest.current) {
        setDetailLoading(false);
      }
    }
  }, []);

  function selectMessage(messageId: string) {
    setSelectedMessageId(messageId);
    if (selectedMailboxId) {
      void loadDetail(selectedMailboxId, messageId);
    }
  }

  async function removeProvider(id: string) {
    try {
      setProviders(await domainApi.deleteProvider(id));
      setMailboxes(await domainApi.mailboxes());
      setNotice("已删除服务商");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function removeMailbox(id: string) {
    try {
      const next = await domainApi.deleteMailbox(id);
      setMailboxes(next);
      if (selectedMailboxId === id) {
        setSelectedMailboxId(null);
      }
      setNotice("已删除邮箱");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function clearSelectedMailbox() {
    if (!selectedMailboxId) {
      return;
    }
    try {
      await domainApi.clearMailbox(selectedMailboxId);
      setMessages([]);
      setSelectedMessageId(null);
      setDetail(null);
      setNotice("收件箱已清空");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function deleteSelectedMessage() {
    if (!selectedMailboxId || !selectedMessageId) {
      return;
    }
    try {
      await domainApi.deleteMessage(selectedMailboxId, selectedMessageId);
      setMessages((current) => current.filter((message) => message.id !== selectedMessageId));
      setSelectedMessageId(null);
      setDetail(null);
      setNotice("已删除邮件");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function copyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setNotice("邮箱地址已复制");
    } catch {
      setNotice("复制失败");
    }
  }

  return (
    <div className="domain-workspace">
      <aside className="domain-mailbox-list">
        <div className="domain-list-header">
          <strong><Globe2 size={16} /> 临时邮箱</strong>
          <div className="domain-list-actions">
            <button type="button" className="dashboard-icon-button" title="添加服务商" onClick={() => setShowAddProvider(true)}>
              <Server size={15} />
            </button>
            <button
              type="button"
              className="dashboard-primary-button"
              onClick={() => setShowGenerate(true)}
              disabled={providers.length === 0}
              title={providers.length === 0 ? "请先添加服务商" : "生成邮箱"}
            >
              <Plus size={14} /> 生成邮箱
            </button>
          </div>
        </div>

        {providers.length > 0 ? (
          <div className="domain-provider-chips">
            {providers.map((provider) => (
              <span key={provider.id} className="domain-provider-chip" title={provider.baseUrl}>
                {provider.name}
                <button type="button" aria-label={`删除服务商 ${provider.name}`} onClick={() => void removeProvider(provider.id)}>
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="domain-empty-hint">还没有服务商，点击右上角服务器图标添加 GPTMail 等 API。</p>
        )}

        <div className="domain-mailbox-scroll">
          {mailboxes.length === 0 ? (
            <div className="panel-empty"><Inbox size={22} /><p>还没有域名邮箱</p></div>
          ) : (
            mailboxes.map((mailbox) => (
              <div
                key={mailbox.id}
                className={`domain-mailbox-row ${mailbox.id === selectedMailboxId ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedMailboxId(mailbox.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setSelectedMailboxId(mailbox.id);
                  }
                }}
              >
                <div className="domain-mailbox-row-text">
                  <strong>{mailbox.email}</strong>
                  <span>{mailbox.remark || mailbox.providerName}</span>
                </div>
                <div className="domain-mailbox-row-actions">
                  <button type="button" title="复制地址" onClick={(event) => { event.stopPropagation(); void copyEmail(mailbox.email); }}>
                    <Copy size={13} />
                  </button>
                  <button type="button" title="删除邮箱" onClick={(event) => { event.stopPropagation(); void removeMailbox(mailbox.id); }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        {notice ? <p className="domain-notice" role="status">{notice}</p> : null}
      </aside>

      <section className="domain-message-list">
        <header className="domain-message-header">
          <div className="domain-message-title">
            <Inbox size={16} />
            <span>{selectedMailbox ? selectedMailbox.email : "收件箱"}</span>
          </div>
          <div className="domain-message-actions">
            <button
              type="button"
              className="dashboard-icon-button"
              title="刷新"
              disabled={!selectedMailboxId || messagesLoading}
              onClick={() => selectedMailboxId && void loadMessages(selectedMailboxId)}
            >
              {messagesLoading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            </button>
            <button
              type="button"
              className="dashboard-icon-button"
              title="清空收件箱"
              disabled={!selectedMailboxId || messages.length === 0}
              onClick={() => void clearSelectedMailbox()}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </header>
        <div className="domain-message-scroll">
          {!selectedMailboxId ? (
            <div className="panel-empty"><Mail size={24} /><p>先在左侧选择一个域名邮箱</p></div>
          ) : messagesError ? (
            <div className="panel-empty panel-error">
              <AlertTriangle size={22} />
              <p>邮件列表加载失败</p>
              <p className="panel-error-title">{messagesError}</p>
              <button type="button" className="panel-error-retry" onClick={() => void loadMessages(selectedMailboxId)}>重试</button>
            </div>
          ) : messagesLoading && messages.length === 0 ? (
            <div className="panel-empty"><Loader2 size={22} className="spin" /><p>正在收取邮件</p></div>
          ) : messages.length === 0 ? (
            <div className="panel-empty"><Inbox size={24} /><p>暂无邮件</p></div>
          ) : (
            messages.map((message) => (
              <button
                key={message.id}
                type="button"
                className={`message-row ${message.id === selectedMessageId ? "selected" : ""} ${message.isRead ? "" : "is-unread"}`}
                onClick={() => selectMessage(message.id)}
              >
                <div className="message-row-top">
                  <strong>{senderLabel(message)}</strong>
                  <span>{formatDate(message.receivedDateTime)}</span>
                </div>
                <div className="message-row-subject">
                  {message.hasAttachments ? <Paperclip size={13} /> : null}
                  {message.subject}
                </div>
                {message.bodyPreview ? <p>{message.bodyPreview}</p> : null}
              </button>
            ))
          )}
        </div>
      </section>

      <DomainReader
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onRetry={() => selectedMailboxId && selectedMessageId && void loadDetail(selectedMailboxId, selectedMessageId)}
        onDelete={() => void deleteSelectedMessage()}
      />

      {showAddProvider ? (
        <AddProviderDialog
          types={providerTypes}
          onClose={() => setShowAddProvider(false)}
          onCreated={(next) => {
            setProviders(next);
            setNotice("已添加服务商");
          }}
        />
      ) : null}
      {showGenerate ? (
        <GenerateMailboxDialog
          providers={providers}
          onClose={() => setShowGenerate(false)}
          onGenerated={(next) => {
            setMailboxes(next);
            setNotice("已生成邮箱");
          }}
        />
      ) : null}
    </div>
  );
}
