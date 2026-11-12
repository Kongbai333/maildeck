import { ImapFlow, type MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailAddress, MailMessageDetail, MailMessageSummary } from "../../electron/shared/ipc-contracts.js";

export type ProviderKind = "temp" | "domain";

export type ProviderConfigField =
  | "baseUrl"
  | "apiKey"
  | "keyMode"
  | "host"
  | "port"
  | "secure"
  | "user"
  | "domain";

export interface DomainProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** 非敏感附加配置：imap 的 host / port / secure / user / domain；多 Key 服务商的 apiKeys。 */
  meta?: Record<string, string>;
  /** 多 Key 服务商（如 YYDS Mail）的全部 Key，按顺序轮换。 */
  apiKeys?: string[];
}

/** 服务商的全部可用 Key：优先 apiKeys，其次 apiKey。 */
export function providerKeys(config: DomainProviderConfig): string[] {
  const list = (config.apiKeys ?? []).map((key) => key.trim()).filter(Boolean);
  if (list.length > 0) {
    return list;
  }
  return config.apiKey.trim() ? [config.apiKey.trim()] : [];
}

/** 单个邮箱自己的凭据（mail.tm 每个地址都有一条独立口令）。 */
export interface DomainMailboxContext {
  email: string;
  secret: string;
}

export interface DomainAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface DomainMessageDetail extends MailMessageDetail {
  attachments: DomainAttachment[];
}

export interface DomainCatalogEntry {
  domain: string;
  wildcard: boolean;
}

export interface DomainPublicKeyInfo {
  key: string;
  isActive: boolean;
  remainingToday: number;
  dailyLimit: number;
  resetAt: string | null;
}

/**
 * 域名/临时邮箱服务商适配器。
 * - kind=temp：临时邮箱（GPTMail、mail.tm），地址由服务商分配；
 * - kind=domain：自有域名邮箱（IMAP catch-all），地址只是别名，邮件都落在同一个 IMAP 账号里。
 */
export interface DomainMailAdapter {
  type: string;
  label: string;
  /** 建服务商时的默认短名，避免表格里被截断。 */
  shortLabel: string;
  kind: ProviderKind;
  defaultBaseUrl: string;
  /** 创建服务商时是否必须填 apiKey（IMAP 是密码）。 */
  requiresKey: boolean;
  /** 管理端表单需要渲染的字段。 */
  configFields: ProviderConfigField[];
  /** 允许把「已有地址」导入到池子/用户名下。 */
  supportsImport: boolean;
  /** 允许让服务端生成新地址。 */
  supportsGenerate: boolean;
  listDomains(config: DomainProviderConfig): Promise<DomainCatalogEntry[]>;
  generateEmail(
    config: DomainProviderConfig,
    options: { prefix?: string; domain?: string }
  ): Promise<{ email: string; secret?: string }>;
  listMessages(
    config: DomainProviderConfig,
    email: string,
    mailbox?: DomainMailboxContext
  ): Promise<MailMessageSummary[]>;
  getMessage(
    config: DomainProviderConfig,
    email: string,
    messageId: string,
    mailbox?: DomainMailboxContext
  ): Promise<DomainMessageDetail>;
  deleteMessage(
    config: DomainProviderConfig,
    email: string,
    messageId: string,
    mailbox?: DomainMailboxContext
  ): Promise<void>;
  clearInbox(config: DomainProviderConfig, email: string, mailbox?: DomainMailboxContext): Promise<void>;
  /** 可选：自动获取站点公共测试 Key（如 GPTMail 每日公共 Key）。 */
  fetchPublicKey?(config: DomainProviderConfig): Promise<DomainPublicKeyInfo>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return "";
}

function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function parseAddress(value: unknown): MailAddress | null {
  if (typeof value === "string" && value.trim()) {
    const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/u);
    if (match) {
      return { name: match[1].replace(/^"|"$/gu, ""), address: match[2].trim() };
    }
    return { name: "", address: value.trim() };
  }
  const record = asRecord(value);
  const address = readString(record, "address", "email");
  if (!address) {
    return null;
  }
  return { name: readString(record, "name"), address };
}

function normalizeSummary(raw: unknown): MailMessageSummary {
  const record = asRecord(raw);
  const from =
    parseAddress(record.from) ??
    (readString(record, "from_address", "sender")
      ? { name: readString(record, "from_name"), address: readString(record, "from_address", "sender") }
      : null);
  const received = toIso(record.timestamp ?? record.created_at ?? record.date ?? record.received_at);
  const attachmentCount =
    Number(record.attachment_count ?? (Array.isArray(record.attachments) ? record.attachments.length : 0)) || 0;
  return {
    id: readString(record, "id", "email_id", "uid"),
    subject: readString(record, "subject") || "(无主题)",
    from,
    receivedDateTime: received,
    sentDateTime: toIso(record.sent_at ?? record.date) ?? received,
    isRead: Boolean(record.seen ?? record.read ?? record.is_read ?? false),
    importance: "normal",
    hasAttachments: attachmentCount > 0 || Boolean(record.has_attachments),
    bodyPreview: readString(record, "intro", "snippet", "preview", "body_preview"),
    webLink: null
  };
}

function normalizeAttachments(raw: unknown): DomainAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => {
    const record = asRecord(item);
    return {
      id: readString(record, "id", "attachment_id"),
      filename: readString(record, "filename", "name") || "attachment",
      contentType: readString(record, "content_type", "contentType", "mime") || "application/octet-stream",
      size: Number(record.size ?? 0) || 0
    };
  });
}

function normalizeDetail(raw: unknown): DomainMessageDetail {
  const record = asRecord(raw);
  const summary = normalizeSummary(raw);
  const html = readString(record, "html_content", "html", "body_html");
  const text = readString(record, "content", "text", "text_content", "body_text", "raw_content");
  const to = parseAddress(record.to ?? record.to_address);
  return {
    ...summary,
    toRecipients: to ? [to] : [],
    ccRecipients: [],
    body: {
      contentType: html ? "html" : "text",
      content: html || text
    },
    attachments: normalizeAttachments(record.attachments)
  };
}

// ───────────────────────────── GPTMail（临时邮箱） ─────────────────────────────

async function gptmailRequest(
  config: DomainProviderConfig,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const base = config.baseUrl.trim().replace(/\/+$/u, "") || "https://mail.chatgpt.org.uk";
  const headers = new Headers(init.headers);
  if (config.apiKey) {
    headers.set("X-API-Key", config.apiKey);
  }
  headers.set("accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`无法连接 GPTMail：${error instanceof Error ? error.message : String(error)}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    if (response.status === 429) {
      throw new Error("GPTMail 限速（HTTP 429），请等待约 10 秒后重试");
    }
    throw new Error(`GPTMail 返回非 JSON 响应（HTTP ${response.status}），可能被 Cloudflare 拦截或限速`);
  }

  const payload = asRecord(await response.json());
  if (!response.ok || payload.success === false) {
    const message = readString(payload, "error") || `GPTMail 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload;
}

const gptmailAdapter: DomainMailAdapter = {
  type: "gptmail",
  label: "GPTMail（临时邮箱）",
  shortLabel: "GPTMail",
  kind: "temp",
  defaultBaseUrl: "https://mail.chatgpt.org.uk",
  requiresKey: false,
  configFields: ["baseUrl", "apiKey", "keyMode"],
  supportsImport: false,
  supportsGenerate: true,

  async listDomains(config) {
    const payload = await gptmailRequest(config, "/api/domains/public");
    const data = asRecord(payload.data);
    const entries: DomainCatalogEntry[] = [];
    const seen = new Set<string>();
    const push = (domain: string, wildcard: boolean) => {
      const name = domain.trim().toLowerCase();
      if (name && !seen.has(name)) {
        seen.add(name);
        entries.push({ domain: name, wildcard });
      }
    };
    if (Array.isArray(data.domains)) {
      for (const item of data.domains) {
        const record = asRecord(item);
        const active = record.is_active === undefined || Boolean(record.is_active);
        const visibility = readString(record, "visibility") || "public";
        if (active && visibility === "public") {
          push(readString(record, "domain_name", "domain"), false);
        }
      }
    }
    if (Array.isArray(data.subdomains)) {
      for (const item of data.subdomains) {
        const record = asRecord(item);
        const domain = readString(record, "domain");
        if (!domain) {
          continue;
        }
        push(domain, Boolean(record.wildcard));
        if (Array.isArray(record.children)) {
          for (const child of record.children) {
            if (typeof child === "string") {
              push(child, false);
            }
          }
        }
      }
    }
    return entries;
  },

  async generateEmail(config, options) {
    const body: Record<string, string> = {};
    if (options.prefix?.trim()) {
      body.prefix = options.prefix.trim();
    }
    if (options.domain?.trim()) {
      body.domain = options.domain.trim();
    }
    const hasBody = Object.keys(body).length > 0;
    const payload = await gptmailRequest(config, "/api/generate-email", {
      method: hasBody ? "POST" : "GET",
      ...(hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    });
    const data = asRecord(payload.data);
    const email = readString(data, "email", "email_address") || readString(payload, "email");
    if (!email) {
      throw new Error("GPTMail 未返回邮箱地址");
    }
    return { email: email.toLowerCase() };
  },

  async listMessages(config, email) {
    const payload = await gptmailRequest(config, `/api/emails?email=${encodeURIComponent(email)}`);
    const data = asRecord(payload.data);
    const rows = Array.isArray(data.emails)
      ? data.emails
      : Array.isArray(data.messages)
        ? data.messages
        : Array.isArray(payload.data)
          ? (payload.data as unknown[])
          : Array.isArray(data.items)
            ? data.items
            : [];
    return rows.map(normalizeSummary).filter((message) => message.id);
  },

  async getMessage(config, email, messageId) {
    const payload = await gptmailRequest(
      config,
      `/api/email/${encodeURIComponent(messageId)}?email=${encodeURIComponent(email)}`
    );
    const data = asRecord(payload.data);
    const raw = data.email ?? data.message ?? (Object.keys(data).length > 0 ? data : payload);
    return normalizeDetail(raw);
  },

  async deleteMessage(config, email, messageId) {
    await gptmailRequest(config, `/api/email/${encodeURIComponent(messageId)}?email=${encodeURIComponent(email)}`, {
      method: "DELETE"
    });
  },

  async clearInbox(config, email) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const payload = await gptmailRequest(config, `/api/emails/clear?email=${encodeURIComponent(email)}`, {
        method: "DELETE"
      });
      const data = asRecord(payload.data);
      if (!data.has_more) {
        return;
      }
    }
  },

  async fetchPublicKey(config) {
    const payload = await gptmailRequest(config, "/api/public-key-status?reveal=1", {
      headers: { "X-Public-Key-Reveal": "click" }
    });
    const data = asRecord(payload.data);
    const key = readString(data, "key");
    if (!key) {
      throw new Error("GPTMail 未返回公共 Key");
    }
    return {
      key,
      isActive: Boolean(data.is_active),
      remainingToday: Number(data.remaining_today ?? 0) || 0,
      dailyLimit: Number(data.daily_limit ?? 0) || 0,
      resetAt: toIso(data.reset_at) ?? (readString(data, "reset_at") || null)
    };
  }
};

// ───────────────────────────── mail.tm（临时邮箱） ─────────────────────────────

const MAILTM_TOKEN_TTL_MS = 20 * 60 * 1_000;
const mailtmTokens = new Map<string, { token: string; expiresAt: number }>();

function randomLocalPart(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function randomPassword(length = 18): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function mailtmRequest(
  config: DomainProviderConfig,
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Record<string, unknown>> {
  const base = config.baseUrl.trim().replace(/\/+$/u, "") || "https://api.mail.tm";
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`无法连接 mail.tm：${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown;
      // mail.tm 的部分接口（/domains 等）直接返回顶层数组，asRecord 会把数组吞成 {}，
      // 这里统一包成 { items: [...] }，交给 mailtmItems 读取。
      payload = Array.isArray(parsed) ? { items: parsed } : asRecord(parsed);
    } catch {
      throw new Error(`mail.tm 返回非 JSON 响应（HTTP ${response.status}）`);
    }
  }
  if (!response.ok) {
    const message =
      readString(payload, "message", "detail", "error") || `mail.tm 请求失败（HTTP ${response.status}）`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

function mailtmItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const member = payload["hydra:member"];
  if (Array.isArray(member)) {
    return member.map(asRecord);
  }
  if (Array.isArray(payload.items)) {
    return payload.items.map(asRecord);
  }
  if (Array.isArray(payload.data)) {
    return payload.data.map(asRecord);
  }
  return [];
}

async function mailtmToken(config: DomainProviderConfig, address: string, password: string): Promise<string> {
  const key = `${config.baseUrl}|${address}`;
  const cached = mailtmTokens.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const payload = await mailtmRequest(config, "/token", {
    method: "POST",
    body: JSON.stringify({ address, password })
  });
  const token = readString(payload, "token");
  if (!token) {
    throw new Error("mail.tm 未返回登录令牌");
  }
  mailtmTokens.set(key, { token, expiresAt: Date.now() + MAILTM_TOKEN_TTL_MS });
  return token;
}

async function mailtmWithToken<T>(
  config: DomainProviderConfig,
  email: string,
  mailbox: DomainMailboxContext | undefined,
  operation: (token: string) => Promise<T>
): Promise<T> {
  const password = mailbox?.secret?.trim();
  if (!password) {
    throw new Error("该邮箱缺少登录口令，请删除后重新生成");
  }
  try {
    return await operation(await mailtmToken(config, email, password));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401) {
      mailtmTokens.delete(`${config.baseUrl}|${email}`);
      return operation(await mailtmToken(config, email, password));
    }
    throw error;
  }
}

const mailtmAdapter: DomainMailAdapter = {
  type: "mailtm",
  label: "mail.tm（临时邮箱）",
  shortLabel: "mail.tm",
  kind: "temp",
  defaultBaseUrl: "https://api.mail.tm",
  requiresKey: false,
  configFields: ["baseUrl"],
  supportsImport: false,
  supportsGenerate: true,

  async listDomains(config) {
    const payload = await mailtmRequest(config, "/domains?page=1");
    return mailtmItems(payload)
      .filter((item) => item.isActive !== false && item.isPrivate !== true)
      .map((item) => ({ domain: readString(item, "domain").toLowerCase(), wildcard: false }))
      .filter((item) => item.domain);
  },

  async generateEmail(config, options) {
    const domains = await this.listDomains(config);
    const preferred = options.domain?.trim().toLowerCase();
    const domain = preferred || domains[0]?.domain || "";
    if (!domain) {
      throw new Error("mail.tm 没有可用域名");
    }
    const prefix = (options.prefix?.trim() || randomLocalPart()).toLowerCase();
    const email = `${prefix}@${domain}`;
    const password = randomPassword();
    await mailtmRequest(config, "/accounts", {
      method: "POST",
      body: JSON.stringify({ address: email, password })
    });
    return { email, secret: password };
  },

  async listMessages(config, email, mailbox) {
    return mailtmWithToken(config, email, mailbox, async (token) => {
      const payload = await mailtmRequest(config, "/messages?page=1", {}, token);
      return mailtmItems(payload)
        .map((item) =>
          normalizeSummary({
            ...item,
            from: item.from,
            timestamp: item.createdAt,
            seen: item.seen,
            has_attachments: item.hasAttachments
          })
        )
        .filter((message) => message.id)
        .sort((left, right) => (right.receivedDateTime ?? "").localeCompare(left.receivedDateTime ?? ""));
    });
  },

  async getMessage(config, email, messageId, mailbox) {
    return mailtmWithToken(config, email, mailbox, async (token) => {
      const payload = await mailtmRequest(config, `/messages/${encodeURIComponent(messageId)}`, {}, token);
      const html = Array.isArray(payload.html) ? payload.html.join("\n") : "";
      const to = Array.isArray(payload.to) ? parseAddress(payload.to[0]) : null;
      const summary = normalizeSummary({
        ...payload,
        from: payload.from,
        timestamp: payload.createdAt,
        seen: payload.seen,
        has_attachments: Array.isArray(payload.attachments) && payload.attachments.length > 0
      });
      return {
        ...summary,
        toRecipients: to ? [to] : [],
        ccRecipients: [],
        body: {
          contentType: html ? "html" : "text",
          content: html || readString(payload, "text") || summary.bodyPreview
        },
        attachments: normalizeAttachments(payload.attachments)
      } satisfies DomainMessageDetail;
    });
  },

  async deleteMessage(config, email, messageId, mailbox) {
    await mailtmWithToken(config, email, mailbox, async (token) => {
      await mailtmRequest(config, `/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" }, token);
    });
  },

  async clearInbox(config, email, mailbox) {
    await mailtmWithToken(config, email, mailbox, async (token) => {
      const payload = await mailtmRequest(config, "/messages?page=1", {}, token);
      for (const item of mailtmItems(payload)) {
        const id = readString(item, "id");
        if (id) {
          await mailtmRequest(config, `/messages/${encodeURIComponent(id)}`, { method: "DELETE" }, token);
        }
      }
    });
  }
};

// ───────────────────────────── IMAP 域名邮箱（catch-all） ─────────────────────────────

const IMAP_TIMEOUT_MS = 20_000;

interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  domain: string;
}

function imapSettings(config: DomainProviderConfig): ImapSettings {
  const meta = config.meta ?? {};
  const host = meta.host?.trim() || "";
  const user = meta.user?.trim() || "";
  const domain = meta.domain?.trim().toLowerCase() || "";
  if (!host || !user || !config.apiKey) {
    throw new Error("IMAP 服务商缺少主机 / 用户名 / 密码配置");
  }
  const port = Number.parseInt(meta.port ?? "", 10);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 993,
    secure: (meta.secure ?? "1") !== "0",
    user,
    password: config.apiKey,
    domain
  };
}

async function withImapClient<T>(
  config: DomainProviderConfig,
  handler: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const settings = imapSettings(config);
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS
  });
  const deferredErrors: Error[] = [];
  client.on("error", (error: unknown) => {
    deferredErrors.push(error instanceof Error ? error : new Error(String(error)));
  });
  try {
    await client.connect();
    const result = await handler(client);
    if (deferredErrors.length > 0) {
      throw deferredErrors[0];
    }
    return result;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function envelopeAddresses(envelope: unknown): string[] {
  const record = asRecord(envelope);
  const out: string[] = [];
  for (const key of ["to", "cc", "bcc"]) {
    const list = record[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const address = readString(asRecord(item), "address").toLowerCase();
      if (address) {
        out.push(address);
      }
    }
  }
  return out;
}

/** catch-all 邮箱里，一封邮件是否属于某个别名（收件人/抄送/密送任一命中）。 */
export function imapMessageMatches(envelope: unknown, email: string): boolean {
  const target = email.trim().toLowerCase();
  if (!target) {
    return false;
  }
  return envelopeAddresses(envelope).includes(target);
}

function structureHasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) {
    return false;
  }
  if (node.disposition?.toLowerCase() === "attachment") {
    return true;
  }
  if (node.dispositionParameters?.filename || node.parameters?.name) {
    return true;
  }
  if (node.type?.toLowerCase() === "message/rfc822") {
    return true;
  }
  return (node.childNodes ?? []).some((child) => structureHasAttachment(child));
}

function envelopeSummary(message: {
  uid: number;
  envelope?: unknown;
  flags?: Set<string>;
  internalDate?: Date | string;
  bodyStructure?: MessageStructureObject;
}): MailMessageSummary {
  const envelope = asRecord(message.envelope);
  const fromList = Array.isArray(envelope.from) ? envelope.from : [];
  const fromRecord = asRecord(fromList[0]);
  const fromAddress = readString(fromRecord, "address");
  const from: MailAddress | null = fromAddress
    ? { name: readString(fromRecord, "name"), address: fromAddress }
    : null;
  const date =
    message.internalDate instanceof Date
      ? message.internalDate.toISOString()
      : toIso(message.internalDate) ?? toIso(envelope.date);
  return {
    id: String(message.uid),
    subject: readString(envelope, "subject") || "(无主题)",
    from,
    receivedDateTime: date,
    sentDateTime: toIso(envelope.date) ?? date,
    isRead: Boolean(message.flags?.has("\\Seen")),
    importance: "normal",
    hasAttachments: structureHasAttachment(message.bodyStructure),
    bodyPreview: "",
    webLink: null
  };
}

function flattenAddresses(value: unknown): MailAddress[] {
  const record = asRecord(value);
  const list = Array.isArray(record.value) ? record.value : [];
  return list
    .map((item) => {
      const entry = asRecord(item);
      const address = readString(entry, "address");
      return address ? { name: readString(entry, "name"), address } : null;
    })
    .filter((item): item is MailAddress => item !== null);
}

const imapAdapter: DomainMailAdapter = {
  type: "imap",
  label: "IMAP 域名邮箱",
  shortLabel: "IMAP",
  kind: "domain",
  defaultBaseUrl: "",
  requiresKey: true,
  configFields: ["host", "port", "secure", "user", "apiKey", "domain"],
  supportsImport: false,
  supportsGenerate: true,

  async listDomains(config) {
    const settings = imapSettings(config);
    return settings.domain ? [{ domain: settings.domain, wildcard: true }] : [];
  },

  async generateEmail(config, options) {
    const settings = imapSettings(config);
    if (!settings.domain) {
      throw new Error("IMAP 服务商缺少域名配置");
    }
    const prefix = (options.prefix?.trim() || randomLocalPart(8)).toLowerCase();
    return { email: `${prefix}@${settings.domain}` };
  },

  async listMessages(config, email) {
    return withImapClient(config, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailboxInfo = client.mailbox;
        const exists = mailboxInfo ? Number(mailboxInfo.exists ?? 0) : 0;
        if (exists === 0) {
          return [];
        }
        const rows: MailMessageSummary[] = [];
        for await (const message of client.fetch("1:*", {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true
        })) {
          if (!imapMessageMatches(message.envelope, email)) {
            continue;
          }
          rows.push(
            envelopeSummary({
              uid: Number(message.uid),
              envelope: message.envelope,
              flags: message.flags,
              internalDate: message.internalDate,
              bodyStructure: message.bodyStructure
            })
          );
        }
        return rows
          .sort((left, right) => (right.receivedDateTime ?? "").localeCompare(left.receivedDateTime ?? ""))
          .slice(0, 100);
      } finally {
        lock.release();
      }
    });
  },

  async getMessage(config, email, messageId) {
    return withImapClient(config, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const message = await client.fetchOne(
          messageId,
          { uid: true, envelope: true, flags: true, internalDate: true, source: true },
          { uid: true }
        );
        if (!message || !message.source) {
          throw new Error("邮件不存在或已被删除");
        }
        const parsed = await simpleParser(message.source);
        const summary = envelopeSummary({
          uid: Number(message.uid ?? messageId),
          envelope: message.envelope,
          flags: message.flags,
          internalDate: message.internalDate,
          bodyStructure: undefined
        });
        const html = typeof parsed.html === "string" ? parsed.html : "";
        const text = parsed.text ?? "";
        return {
          ...summary,
          subject: parsed.subject?.trim() || summary.subject,
          toRecipients: flattenAddresses(parsed.to),
          ccRecipients: flattenAddresses(parsed.cc),
          body: { contentType: html ? "html" : "text", content: html || text },
          attachments: parsed.attachments.map((item, index) => ({
            id: String(index),
            filename: item.filename ?? "attachment",
            contentType: item.contentType ?? "application/octet-stream",
            size: item.size ?? 0
          }))
        } satisfies DomainMessageDetail;
      } finally {
        lock.release();
      }
    });
  },

  async deleteMessage(config, _email, messageId) {
    await withImapClient(config, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageDelete(messageId, { uid: true });
      } finally {
        lock.release();
      }
    });
  },

  async clearInbox(config, email) {
    await withImapClient(config, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailboxInfo = client.mailbox;
        const exists = mailboxInfo ? Number(mailboxInfo.exists ?? 0) : 0;
        if (exists === 0) {
          return;
        }
        const uids: string[] = [];
        for await (const message of client.fetch("1:*", { uid: true, envelope: true })) {
          if (imapMessageMatches(message.envelope, email)) {
            uids.push(String(message.uid));
          }
        }
        for (const uid of uids) {
          await client.messageDelete(uid, { uid: true });
        }
      } finally {
        lock.release();
      }
    });
  }
};

// ───────────────────────── YYDS Mail / 215.im（临时邮箱，支持多 Key） ─────────────────────────
// 文档：https://vip.215.im/docs   基础地址：https://maliapi.215.im/v1
// 认证：X-API-Key: AC-xxxx（多把 Key 轮换），创建账号返回的 token 也可作 Bearer 使用。

function yydsBase(config: DomainProviderConfig): string {
  return (config.baseUrl.trim().replace(/\/+$/u, "") || "https://maliapi.215.im").replace(/\/v1$/u, "");
}

async function yydsRequest(
  config: DomainProviderConfig,
  path: string,
  init: RequestInit = {},
  options: { key?: string; bearer?: string } = {}
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (options.bearer) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  } else if (options.key) {
    headers.set("X-API-Key", options.key);
  }

  // YYDS 后端（Cloudflare 前置）响应偏慢且偶发连接超时，这里做 3 次重试 + 45s 超时，避免偶发抖动直接被判失败。
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${yydsBase(config)}/v1${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(45_000)
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  }
  if (response === null) {
    throw new Error(`无法连接 YYDS Mail：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      payload = asRecord(JSON.parse(text) as unknown);
    } catch {
      throw new Error(`YYDS Mail 返回非 JSON 响应（HTTP ${response.status}）`);
    }
  }
  if (!response.ok || payload.success === false) {
    const message =
      readString(payload, "message", "error", "detail") || `YYDS Mail 请求失败（HTTP ${response.status}）`;
    const error = new Error(message) as Error & { status?: number; keyRejected?: boolean };
    error.status = response.status;
    error.keyRejected = response.status === 401 || response.status === 403 || response.status === 429;
    throw error;
  }
  return payload;
}

/** 多 Key 轮换：遇到 401/403/429 换下一把 Key 重试，全部失败抛最后一个错误。 */
async function yydsWithKeys<T>(
  config: DomainProviderConfig,
  operation: (key: string) => Promise<T>
): Promise<T> {
  const keys = providerKeys(config);
  if (keys.length === 0) {
    throw new Error("YYDS Mail 服务商缺少 API Key");
  }
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return await operation(key);
    } catch (error) {
      lastError = error;
      if (!(error as { keyRejected?: boolean }).keyRejected) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function yydsMessage(raw: unknown): Record<string, unknown> {
  return asRecord(raw);
}

function yydsSummary(raw: unknown): ReturnType<typeof normalizeSummary> {
  const record = yydsMessage(raw);
  return normalizeSummary({
    id: record.id,
    subject: record.subject,
    from: record.from,
    timestamp: record.createdAt ?? record.created_at,
    seen: record.seen,
    has_attachments: record.hasAttachments,
    intro: record.intro ?? record.preview ?? ""
  });
}

const yydsAdapter: DomainMailAdapter = {
  type: "yyds",
  label: "YYDS Mail（临时邮箱）",
  shortLabel: "YYDS",
  kind: "temp",
  defaultBaseUrl: "https://maliapi.215.im",
  requiresKey: true,
  configFields: ["baseUrl", "apiKey"],
  supportsImport: false,
  supportsGenerate: true,

  async listDomains(config) {
    const payload = await yydsRequest(config, "/domains");
    const data = asRecord(payload.data);
    const rows = Array.isArray(data.domains)
      ? data.domains
      : Array.isArray(payload.data)
        ? (payload.data as unknown[])
        : Array.isArray(data.items)
          ? data.items
          : [];
    return rows
      .map((item) => {
        const record = asRecord(item);
        return {
          domain: readString(record, "domain", "domain_name", "name").toLowerCase(),
          wildcard: Boolean(record.wildcard ?? record.isWildcard)
        };
      })
      .filter((entry) => entry.domain);
  },

  async generateEmail(config, options) {
    const body: Record<string, unknown> = {};
    if (options.prefix?.trim()) {
      body.localPart = options.prefix.trim();
    }
    if (options.domain?.trim()) {
      body.domain = options.domain.trim();
    }
    const payload = await yydsWithKeys(config, (key) =>
      yydsRequest(config, "/accounts", { method: "POST", body: JSON.stringify(body) }, { key })
    );
    const data = asRecord(payload.data);
    const address = readString(data, "address").toLowerCase();
    if (!address) {
      throw new Error("YYDS Mail 未返回邮箱地址");
    }
    return { email: address, secret: readString(data, "token") || undefined };
  },

  async listMessages(config, email, mailbox) {
    const query = new URLSearchParams({ address: email, limit: "50" });
    const payload = await yydsWithKeys(config, (key) =>
      yydsRequest(config, `/messages?${query.toString()}`, {}, { key }).catch((error: unknown) => {
        if (mailbox?.secret && (error as { keyRejected?: boolean }).keyRejected) {
          return yydsRequest(config, `/messages?${query.toString()}`, {}, { bearer: mailbox.secret });
        }
        throw error;
      })
    );
    const data = asRecord(payload.data);
    const rows = Array.isArray(data.messages) ? data.messages : [];
    return rows
      .map(yydsSummary)
      .filter((message) => message.id)
      .sort((left, right) => (right.receivedDateTime ?? "").localeCompare(left.receivedDateTime ?? ""));
  },

  async getMessage(config, email, messageId, mailbox) {
    const query = new URLSearchParams({ address: email });
    const payload = await yydsWithKeys(config, (key) =>
      yydsRequest(config, `/messages/${encodeURIComponent(messageId)}?${query.toString()}`, {}, { key }).catch(
        (error: unknown) => {
          if (mailbox?.secret && (error as { keyRejected?: boolean }).keyRejected) {
            return yydsRequest(
              config,
              `/messages/${encodeURIComponent(messageId)}?${query.toString()}`,
              {},
              { bearer: mailbox.secret }
            );
          }
          throw error;
        }
      )
    );
    return yydsDetail(payload);
  },

  async deleteMessage(config, email, messageId) {
    const query = new URLSearchParams({ address: email });
    await yydsWithKeys(config, (key) =>
      yydsRequest(config, `/messages/${encodeURIComponent(messageId)}?${query.toString()}`, { method: "DELETE" }, { key })
    );
  },

  async clearInbox(config, email, mailbox) {
    const messages = await this.listMessages(config, email, mailbox);
    for (const message of messages) {
      const query = new URLSearchParams({ address: email });
      await yydsWithKeys(config, (key) =>
        yydsRequest(
          config,
          `/messages/${encodeURIComponent(message.id)}?${query.toString()}`,
          { method: "DELETE" },
          { key }
        )
      );
    }
  }
};

function yydsDetail(payload: Record<string, unknown>): DomainMessageDetail {
  const record = asRecord(payload.data);
  const summary = yydsSummary(record);
  const html = Array.isArray(record.html) ? record.html.filter((item) => typeof item === "string").join("\n") : "";
  const text = readString(record, "text", "text_content");
  const to = Array.isArray(record.to) ? parseAddress(record.to[0]) : null;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.map((item, index) => {
        const entry = asRecord(item);
        return {
          id: readString(entry, "id") || String(index),
          filename: readString(entry, "filename", "name") || "attachment",
          contentType: readString(entry, "contentType", "content_type", "mime") || "application/octet-stream",
          size: Number(entry.size ?? 0) || 0
        };
      })
    : [];
  return {
    ...summary,
    toRecipients: to ? [to] : [],
    ccRecipients: [],
    body: { contentType: html ? "html" : "text", content: html || text },
    attachments
  };
}

export const DOMAIN_ADAPTERS: Record<string, DomainMailAdapter> = {
  [gptmailAdapter.type]: gptmailAdapter,
  [mailtmAdapter.type]: mailtmAdapter,
  [imapAdapter.type]: imapAdapter,
  [yydsAdapter.type]: yydsAdapter
};

export function getAdapter(type: string): DomainMailAdapter {
  const adapter = DOMAIN_ADAPTERS[type];
  if (!adapter) {
    throw new Error(`不支持的域名邮箱服务商类型：${type}`);
  }
  return adapter;
}

export function listAdapterTypes() {
  return Object.values(DOMAIN_ADAPTERS).map((adapter) => ({
    type: adapter.type,
    label: adapter.label,
    kind: adapter.kind,
    defaultBaseUrl: adapter.defaultBaseUrl,
    requiresKey: adapter.requiresKey,
    configFields: adapter.configFields,
    supportsImport: adapter.supportsImport,
    supportsGenerate: adapter.supportsGenerate
  }));
}
