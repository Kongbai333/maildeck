import { randomUUID } from "node:crypto";
import type { MailMessageSummary } from "../../electron/shared/ipc-contracts.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { getDb } from "./db.js";
import {
  getAdapter,
  listAdapterTypes,
  type DomainMailboxContext,
  type DomainMessageDetail,
  type DomainProviderConfig,
  type ProviderKind
} from "./domain-adapters.js";

export type ProviderKeyMode = "public" | "personal";

export interface DomainProviderView {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  hasKey: boolean;
  /** 已配置的 Key 数量（多 Key 服务商 > 1）。 */
  keyCount: number;
  enabled: boolean;
  mailboxCount: number;
  keyMode: ProviderKeyMode;
  typeLabel: string;
  kind: ProviderKind;
  meta: Record<string, string>;
}

/** 用户侧可见的服务商摘要：不含任何密钥。 */
export interface ProviderOptionView {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  kind: ProviderKind;
  supportsImport: boolean;
  supportsGenerate: boolean;
  domain: string;
}

export interface DomainMailboxView {
  id: string;
  providerId: string;
  providerName: string;
  email: string;
  prefix: string;
  domain: string;
  remark: string;
  createdAt: string;
}

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  encrypted_api_key: string;
  enabled: number;
  key_mode: ProviderKeyMode;
  meta_json: string;
}

interface MailboxRow {
  id: string;
  provider_id: string;
  email: string;
  prefix: string;
  domain: string;
  remark: string;
  secret_encrypted?: string;
  created_at: string;
  provider_name?: string;
}

const META_KEYS = ["host", "port", "secure", "user", "domain"] as const;

function nowIso() {
  return new Date().toISOString();
}

function isPublic(row: ProviderRow): boolean {
  return (row.key_mode || "public") === "public";
}

function parseMeta(value: string | null | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const key of META_KEYS) {
      const item = (parsed as Record<string, unknown>)[key];
      if (typeof item === "string" && item.trim()) {
        out[key] = item.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeMeta(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const source = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of META_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "secure") {
      out.secure = value === false || value === "0" || value === 0 ? "0" : "1";
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
    }
  }
  return out;
}

function parseApiKeys(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    }
  } catch {
    // 允许用换行/逗号手填
  }
  return value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean);
}

function parseEncryptedKeys(row: ProviderRow): string[] {
  const raw = (() => {
    try {
      const parsed: unknown = JSON.parse(row.meta_json);
      const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).apiKeysEnc : undefined;
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  })();
  if (!raw) return [];
  try {
    return parseApiKeys(decryptSecret(raw));
  } catch {
    return [];
  }
}

function providerConfig(row: ProviderRow): DomainProviderConfig {
  const primary = row.encrypted_api_key ? decryptSecret(row.encrypted_api_key) : "";
  const extra = parseEncryptedKeys(row);
  return {
    baseUrl: row.base_url,
    apiKey: primary,
    meta: parseMeta(row.meta_json),
    apiKeys: [primary, ...extra].filter(Boolean)
  };
}

function providerViewBase(row: ProviderRow) {
  const adapter = getAdapter(row.type);
  return {
    typeLabel: adapter.label,
    kind: adapter.kind,
    meta: parseMeta(row.meta_json)
  };
}

export function getProviderRow(providerId: string): ProviderRow {
  const row = getDb()
    .prepare("SELECT * FROM domain_providers WHERE id = ?")
    .get(providerId) as ProviderRow | undefined;
  if (!row) {
    throw new Error("服务商不存在");
  }
  return row;
}

function updateProviderApiKey(providerId: string, apiKey: string) {
  getDb()
    .prepare("UPDATE domain_providers SET encrypted_api_key = ?, updated_at = ? WHERE id = ?")
    .run(encryptSecret(apiKey), nowIso(), providerId);
}

async function fetchFreshPublicKey(row: ProviderRow): Promise<string | null> {
  const adapter = getAdapter(row.type);
  if (!adapter.fetchPublicKey) {
    return null;
  }
  try {
    const info = await adapter.fetchPublicKey(providerConfig(row));
    return info.key.trim() || null;
  } catch {
    return null;
  }
}

/**
 * GPTMail 公共 Key 每日重置。启动时刷新所有公共 Key 服务商；个人 Key 保持不动。
 * 返回成功刷新的条数，单个服务商失败不影响其余服务商。
 */
export async function refreshPublicProviderKeys(): Promise<number> {
  const rows = getDb()
    .prepare("SELECT * FROM domain_providers WHERE enabled = 1")
    .all() as unknown as ProviderRow[];
  let refreshed = 0;
  for (const row of rows) {
    if (!isPublic(row)) {
      continue;
    }
    const key = await fetchFreshPublicKey(row);
    if (key) {
      updateProviderApiKey(row.id, key);
      refreshed += 1;
    }
  }
  return refreshed;
}

/** 首次启动或误删服务商时自动补齐一个公共 Key 服务商，免去手工配置。 */
export async function ensureDefaultPublicProvider(): Promise<void> {
  const existing = getDb()
    .prepare("SELECT id FROM domain_providers WHERE enabled = 1 AND type = 'gptmail' AND key_mode = 'public'")
    .all() as Array<{ id: string }>;
  if (existing.length > 0) {
    return;
  }
  const adapter = getAdapter("gptmail");
  if (!adapter.fetchPublicKey) {
    return;
  }
  try {
    const info = await adapter.fetchPublicKey({ baseUrl: adapter.defaultBaseUrl, apiKey: "", meta: {} });
    if (!info.key.trim()) {
      return;
    }
    createProvider({
      name: adapter.shortLabel,
      type: adapter.type,
      baseUrl: adapter.defaultBaseUrl,
      apiKey: info.key,
      keyMode: "public"
    });
  } catch {
    // 启动阶段网络不可用时保持静默，后续请求会走失效自愈。
  }
}

function isInvalidKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // 公共 Key 每日额度用尽（Daily quota exceeded / 429）也按「Key 需要换」处理，刷新后重试一次。
  return /invalid api key|api key.*(invalid|expired|unauthorized|无效|过期)|unauthorized|HTTP 401|quota exceeded|daily quota|HTTP 429|rate limit/iu.test(message);
}

/** 公共 Key 过期时自动换当日 Key 并重试一次，个人 Key 原样抛错。 */
async function withAutoRefreshedKey<T>(
  provider: ProviderRow,
  operation: (config: DomainProviderConfig) => Promise<T>
): Promise<T> {
  try {
    return await operation(providerConfig(provider));
  } catch (error) {
    if (!isPublic(provider) || !isInvalidKeyError(error)) {
      throw error;
    }
    const fresh = await fetchFreshPublicKey(provider);
    if (!fresh) {
      throw error;
    }
    updateProviderApiKey(provider.id, fresh);
    return operation({ ...providerConfig(provider), apiKey: fresh });
  }
}

export function listProviderTypes() {
  return listAdapterTypes();
}

export async function fetchProviderPublicKey(type: string, baseUrl?: string) {
  const adapter = getAdapter(type);
  if (!adapter.fetchPublicKey) {
    throw new Error("该服务商不支持自动获取公共 Key，请手动填写 API Key");
  }
  return adapter.fetchPublicKey({
    baseUrl: (baseUrl?.trim() || adapter.defaultBaseUrl).replace(/\/+$/u, ""),
    apiKey: "",
    meta: {}
  });
}

export function listProviders(): DomainProviderView[] {
  const rows = getDb()
    .prepare(`
      SELECT p.*, COUNT(m.id) AS mailbox_count
      FROM domain_providers p
      LEFT JOIN domain_mailboxes m ON m.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at ASC
    `)
    .all() as unknown as Array<ProviderRow & { mailbox_count: number }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    hasKey: Boolean(row.encrypted_api_key) || parseEncryptedKeys(row).length > 0,
    keyCount: (row.encrypted_api_key ? 1 : 0) + parseEncryptedKeys(row).length,
    enabled: Boolean(row.enabled),
    mailboxCount: row.mailbox_count,
    keyMode: isPublic(row) ? "public" : "personal",
    ...providerViewBase(row)
  }));
}

export function listProviderOptions(): ProviderOptionView[] {
  const rows = getDb()
    .prepare("SELECT * FROM domain_providers WHERE enabled = 1 ORDER BY created_at ASC")
    .all() as unknown as ProviderRow[];
  return rows.map((row) => {
    const adapter = getAdapter(row.type);
    const meta = parseMeta(row.meta_json);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      typeLabel: adapter.label,
      kind: adapter.kind,
      supportsImport: adapter.supportsImport,
      supportsGenerate: adapter.supportsGenerate,
      domain: meta.domain ?? ""
    };
  });
}

export function getProviderOption(providerId: string): ProviderOptionView {
  const row = getProviderRow(providerId);
  const adapter = getAdapter(row.type);
  const meta = parseMeta(row.meta_json);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    typeLabel: adapter.label,
    kind: adapter.kind,
    supportsImport: adapter.supportsImport,
    supportsGenerate: adapter.supportsGenerate,
    domain: meta.domain ?? ""
  };
}

export function createProvider(input: {
  name: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeys?: unknown;
  keyMode?: ProviderKeyMode;
  meta?: unknown;
}): DomainProviderView[] {
  const adapter = getAdapter(input.type);
  const name = input.name.trim() || adapter.shortLabel;
  const extraKeys = Array.isArray(input.apiKeys)
    ? input.apiKeys
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : typeof input.apiKeys === "string"
      ? input.apiKeys
          .split(/[\n,]/u)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  // 去重：允许「apiKey 传第一把 + apiKeys 传全部」，也允许只传 apiKeys。
  const allKeys = Array.from(new Set([(input.apiKey ?? "").trim(), ...extraKeys].filter(Boolean)));
  const apiKey = allKeys[0] ?? "";
  const extraKeyList = allKeys.slice(1);
  if (adapter.requiresKey && allKeys.length === 0) {
    throw new Error(adapter.type === "imap" ? "请填写 IMAP 账号密码" : "请填写 API Key");
  }
  const meta = normalizeMeta(input.meta);
  if (adapter.type === "imap") {
    if (!meta.host || !meta.user || !meta.domain) {
      throw new Error("IMAP 服务商需要填写主机、用户名和域名");
    }
    meta.port = meta.port ?? "993";
    meta.secure = meta.secure ?? "1";
  }
  const fallbackBaseUrl =
    adapter.type === "imap" && meta.host
      ? `${meta.secure === "0" ? "imap" : "imaps"}://${meta.host}:${meta.port ?? "993"}`
      : adapter.defaultBaseUrl;
  const baseUrl = (input.baseUrl?.trim() || fallbackBaseUrl).replace(/\/+$/u, "");
  const keyMode: ProviderKeyMode = input.keyMode === "personal" ? "personal" : "public";
  const timestamp = nowIso();
  getDb()
    .prepare(`
      INSERT INTO domain_providers (id, name, type, base_url, encrypted_api_key, enabled, key_mode, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      name,
      input.type,
      baseUrl,
      apiKey ? encryptSecret(apiKey) : "",
      keyMode,
      JSON.stringify(
        extraKeyList.length > 0
          ? { ...meta, apiKeysEnc: encryptSecret(JSON.stringify(extraKeyList)) }
          : meta
      ),
      timestamp,
      timestamp
    );
  return listProviders();
}

export function deleteProvider(providerId: string): DomainProviderView[] {
  getProviderRow(providerId);
  getDb().prepare("DELETE FROM domain_providers WHERE id = ?").run(providerId);
  return listProviders();
}

export async function listProviderDomains(providerId: string) {
  const provider = getProviderRow(providerId);
  const adapter = getAdapter(provider.type);
  if (adapter.type === "imap") {
    const meta = parseMeta(provider.meta_json);
    return meta.domain ? [{ domain: meta.domain, wildcard: true }] : [];
  }
  return withAutoRefreshedKey(provider, (config) => adapter.listDomains(config));
}

export function listMailboxes(): DomainMailboxView[] {
  const rows = getDb()
    .prepare(`
      SELECT m.*, p.name AS provider_name
      FROM domain_mailboxes m
      LEFT JOIN domain_providers p ON p.id = m.provider_id
      ORDER BY m.created_at DESC
    `)
    .all() as unknown as MailboxRow[];
  return rows.map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name || "",
    email: row.email,
    prefix: row.prefix,
    domain: row.domain,
    remark: row.remark,
    createdAt: row.created_at
  }));
}

function getMailboxRow(mailboxId: string): MailboxRow {
  const row = getDb()
    .prepare("SELECT * FROM domain_mailboxes WHERE id = ?")
    .get(mailboxId) as MailboxRow | undefined;
  if (!row) {
    throw new Error("邮箱不存在");
  }
  return row;
}

export interface MailboxUpsertResult {
  id: string;
  email: string;
  created: boolean;
}

/** 把地址写进邮箱池；已存在时只更新备注/口令，并保留原有归属关系。 */
export function upsertMailboxRow(input: {
  providerId: string;
  email: string;
  remark?: string;
  secret?: string;
}): MailboxUpsertResult {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("邮箱地址格式不正确");
  }
  const db = getDb();
  const existing = db.prepare("SELECT id FROM domain_mailboxes WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  const timestamp = nowIso();
  if (existing) {
    if (input.remark !== undefined) {
      db.prepare("UPDATE domain_mailboxes SET remark = ?, updated_at = ? WHERE id = ?").run(
        input.remark.trim(),
        timestamp,
        existing.id
      );
    }
    if (input.secret) {
      db.prepare("UPDATE domain_mailboxes SET secret_encrypted = ?, updated_at = ? WHERE id = ?").run(
        encryptSecret(input.secret),
        timestamp,
        existing.id
      );
    }
    return { id: existing.id, email, created: false };
  }
  const [prefix, domain] = email.split("@");
  const id = randomUUID();
  db.prepare(`
    INSERT INTO domain_mailboxes
      (id, provider_id, email, prefix, domain, remark, secret_encrypted, status, assigned_user_id, assigned_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available', NULL, NULL, ?, ?)
  `).run(
    id,
    input.providerId,
    email,
    prefix || "",
    domain || "",
    input.remark?.trim() || "",
    input.secret ? encryptSecret(input.secret) : "",
    timestamp,
    timestamp
  );
  return { id, email, created: true };
}

export async function generateMailbox(input: {
  providerId: string;
  prefix?: string;
  domain?: string;
  remark?: string;
}): Promise<DomainMailboxView[]> {
  const provider = getProviderRow(input.providerId);
  const adapter = getAdapter(provider.type);
  const { email, secret } = await withAutoRefreshedKey(provider, (config) =>
    adapter.generateEmail(config, { prefix: input.prefix, domain: input.domain })
  );
  upsertMailboxRow({ providerId: input.providerId, email, remark: input.remark, secret });
  return listMailboxes();
}

/**
 * 批量生成：逐个调用服务商接口，单个失败不影响已成功的地址。
 * 返回创建/命中的地址和失败原因，供管理员界面展示。
 */
export async function generateMailboxBatch(input: {
  providerId: string;
  prefix?: string;
  domain?: string;
  count: number;
  remark?: string;
}): Promise<{ mailboxes: MailboxUpsertResult[]; errors: string[] }> {
  const provider = getProviderRow(input.providerId);
  const adapter = getAdapter(provider.type);
  const mailboxes: MailboxUpsertResult[] = [];
  const errors: string[] = [];
  const total = Math.min(Math.max(input.count, 1), 20);
  for (let index = 0; index < total; index += 1) {
    try {
      const { email, secret } = await withAutoRefreshedKey(provider, (config) =>
        adapter.generateEmail(config, { prefix: input.prefix, domain: input.domain })
      );
      mailboxes.push(upsertMailboxRow({ providerId: input.providerId, email, remark: input.remark, secret }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (mailboxes.length === 0) {
        break;
      }
    }
  }
  return { mailboxes, errors };
}

export function deleteMailbox(mailboxId: string): DomainMailboxView[] {
  getMailboxRow(mailboxId);
  getDb().prepare("DELETE FROM domain_mailboxes WHERE id = ?").run(mailboxId);
  return listMailboxes();
}

interface MailboxContext {
  mailbox: MailboxRow;
  provider: ProviderRow;
  adapter: ReturnType<typeof getAdapter>;
  credentials: DomainMailboxContext;
}

function mailboxContext(mailboxId: string): MailboxContext {
  const mailbox = getMailboxRow(mailboxId);
  const provider = getProviderRow(mailbox.provider_id);
  return {
    mailbox,
    provider,
    adapter: getAdapter(provider.type),
    credentials: {
      email: mailbox.email,
      secret: mailbox.secret_encrypted ? decryptSecret(mailbox.secret_encrypted) : ""
    }
  };
}

export async function listMailboxMessages(mailboxId: string): Promise<MailMessageSummary[]> {
  const { mailbox, provider, adapter, credentials } = mailboxContext(mailboxId);
  return withAutoRefreshedKey(provider, (config) => adapter.listMessages(config, mailbox.email, credentials));
}

export async function getMailboxMessage(mailboxId: string, messageId: string): Promise<DomainMessageDetail> {
  const { mailbox, provider, adapter, credentials } = mailboxContext(mailboxId);
  return withAutoRefreshedKey(provider, (config) =>
    adapter.getMessage(config, mailbox.email, messageId, credentials)
  );
}

export async function deleteMailboxMessage(mailboxId: string, messageId: string): Promise<void> {
  const { mailbox, provider, adapter, credentials } = mailboxContext(mailboxId);
  await withAutoRefreshedKey(provider, (config) =>
    adapter.deleteMessage(config, mailbox.email, messageId, credentials)
  );
}

export async function clearMailbox(mailboxId: string): Promise<void> {
  const { mailbox, provider, adapter, credentials } = mailboxContext(mailboxId);
  await withAutoRefreshedKey(provider, (config) => adapter.clearInbox(config, mailbox.email, credentials));
}
