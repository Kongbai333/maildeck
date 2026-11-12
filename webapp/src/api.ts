import type {
  AcquireMailboxInput,
  AcquireMailboxResult,
  AdminMailboxView,
  AdminStats,
  AdminUserView,
  BulkMailboxInput,
  BulkMailboxResult,
  BulkDeleteResult,
  ChangePasswordInput,
  ClaimMailboxResult,
  CreateProviderInput,
  CreateUserInput,
  DomainEntry,
  GenerateMailboxInput,
  GenerateMailboxResult,
  ImportMailboxInput,
  ImportMailboxResult,
  ImportOutlookInput,
  ImportOutlookResult,
  KeyMode,
  LoginInput,
  MailboxStatus,
  MailboxView,
  MessageDetail,
  MessageSummary,
  MyGenerateMailboxInput,
  MyGenerateMailboxResult,
  MyImportMailboxInput,
  MyImportMailboxResult,
  OnlineHost,
  OnlinePlatform,
  Overview,
  ProviderConfigField,
  ProviderKind,
  ProviderOption,
  ProviderTypeView,
  ProviderView,
  QuotaBuckets,
  RefreshKeysResult,
  SessionUser,
  UpdateUserInput,
} from "./types";

/** 通用接口错误：code 来自后端信封，status 为 HTTP 状态码（网络失败为 0）。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** 401 单独成类，由上层统一跳登录页。 */
export class UnauthorizedError extends ApiError {
  constructor(message = "登录已失效，请重新登录") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface ErrorPayload {
  code: string;
  message: string;
}

function readErrorPayload(payload: unknown): ErrorPayload | null {
  if (!isRecord(payload)) return null;
  const raw = payload.error;
  if (!isRecord(raw)) return null;
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";
  if (code === "" && message === "") return null;
  return { code: code === "" ? "UNKNOWN" : code, message: message === "" ? "请求失败" : message };
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return "请求参数有误";
    case 401:
      return "登录已失效，请重新登录";
    case 403:
      return "没有权限执行该操作";
    case 404:
      return "资源不存在";
    case 409:
      return "操作冲突，请刷新后重试";
    case 429:
      return "操作过于频繁，请稍后再试";
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** 登录接口用：401 表示账号密码错误，不当作会话失效。 */
  unauthorizedAsApiError?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, unauthorizedAsApiError = false } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError("NETWORK_ERROR", "网络请求失败，请检查网络或服务状态", 0);
  }

  const payload = parseJson(text);
  const errorPayload = readErrorPayload(payload);

  if (response.status === 401 && !unauthorizedAsApiError) {
    throw new UnauthorizedError(errorPayload?.message ?? "登录已失效，请重新登录");
  }

  if (!response.ok || (isRecord(payload) && payload.ok === false)) {
    throw new ApiError(
      errorPayload?.code ?? `HTTP_${response.status}`,
      errorPayload?.message ?? fallbackMessage(response.status),
      response.status,
    );
  }

  // 成功信封：{ ok: true, value }；少数写接口直接返回 { ok: true }。
  if (isRecord(payload) && "value" in payload) {
    return payload.value as T;
  }
  return payload as T;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

/* --------------------- v2 字段归一化（兼容旧后端） --------------------- */

const CONFIG_FIELDS: readonly ProviderConfigField[] = [
  "baseUrl",
  "apiKey",
  "keyMode",
  "host",
  "port",
  "secure",
  "user",
  "domain",
];

/** 旧后端还没返回 v2 字段时，按已知类型补齐，保证表单仍可渲染。 */
const PROVIDER_TYPE_FALLBACK: Record<string, Omit<ProviderTypeView, "type">> = {
  gptmail: {
    label: "GPTMail",
    kind: "temp",
    defaultBaseUrl: "",
    requiresKey: true,
    configFields: ["baseUrl", "apiKey", "keyMode"],
  },
  mailtm: {
    label: "mail.tm",
    kind: "temp",
    defaultBaseUrl: "https://api.mail.tm",
    requiresKey: false,
    configFields: ["baseUrl"],
  },
  imap: {
    label: "IMAP 域名邮箱",
    kind: "domain",
    defaultBaseUrl: "",
    requiresKey: true,
    configFields: ["host", "port", "secure", "user", "apiKey", "domain"],
  },
  outlook: {
    label: "Outlook",
    kind: "outlook",
    defaultBaseUrl: "",
    requiresKey: false,
    configFields: ["baseUrl", "apiKey", "keyMode"],
  },
  yyds: {
    label: "YYDS Mail（临时邮箱）",
    kind: "temp",
    defaultBaseUrl: "",
    requiresKey: true,
    configFields: ["baseUrl", "apiKey"],
  },
  cfmail: {
    label: "Cloudflare 域名邮箱",
    kind: "domain",
    defaultBaseUrl: "",
    requiresKey: true,
    configFields: ["baseUrl", "apiKey", "domain"],
  },
  cloudmail: {
    label: "Cloud Mail（域名邮箱 API）",
    kind: "domain",
    defaultBaseUrl: "",
    requiresKey: true,
    configFields: ["baseUrl", "user", "apiKey", "domain"],
  },
};

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** keyCount 缺失时按 hasKey ? 1 : 0 兜底（兼容旧后端） */
function readKeyCount(source: Record<string, unknown>): number {
  const value = source.keyCount;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return source.hasKey === true ? 1 : 0;
}

function readKind(value: unknown, fallback: ProviderKind): ProviderKind {
  return value === "domain" || value === "temp" || value === "outlook" ? value : fallback;
}

function readOptionalKind(value: unknown): ProviderKind | undefined {
  return value === "domain" || value === "temp" || value === "outlook" ? value : undefined;
}

/** 三类配额对象；三个键都不是数字时返回 undefined，交给上层退回旧字段 */
function readQuotaBuckets(value: unknown): QuotaBuckets | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["outlook", "domain", "temp"] as const;
  if (!keys.some((key) => typeof value[key] === "number")) return undefined;
  const buckets = {} as QuotaBuckets;
  for (const key of keys) {
    const raw = value[key];
    buckets[key] = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  }
  return buckets;
}

function normalizeSessionUser(raw: unknown): SessionUser {
  const record = isRecord(raw) ? raw : {};
  return {
    id: readString(record, "id"),
    username: readString(record, "username"),
    role: record.role === "admin" ? "admin" : "user",
    status: record.status === "disabled" ? "disabled" : "active",
    mailboxQuota: readNumber(record, "mailboxQuota"),
    quotas: readQuotaBuckets(record.quotas),
    quotaUsage: readQuotaBuckets(record.quotaUsage),
    canOnlinePlay: record.canOnlinePlay === true,
  };
}

function normalizeAdminUser(raw: unknown): AdminUserView {
  const record = isRecord(raw) ? raw : {};
  const lastLoginAt = record.lastLoginAt;
  return {
    ...normalizeSessionUser(raw),
    mailboxCount: readNumber(record, "mailboxCount"),
    mailboxCounts: readQuotaBuckets(record.mailboxCounts),
    createdAt: readString(record, "createdAt"),
    lastLoginAt: typeof lastLoginAt === "string" ? lastLoginAt : null,
  };
}

function readConfigFields(value: unknown, fallback: ProviderConfigField[]): ProviderConfigField[] {
  if (!Array.isArray(value)) return fallback;
  const picked: ProviderConfigField[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const matched = CONFIG_FIELDS.find((field) => field === item);
    if (matched !== undefined && !picked.includes(matched)) picked.push(matched);
  }
  return picked.length > 0 ? picked : fallback;
}

function readMeta(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const meta: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") meta[key] = item;
  }
  return meta;
}

function normalizeAdminMailbox(raw: unknown): AdminMailboxView {
  const record = isRecord(raw) ? raw : {};
  const assignedUserId = record.assignedUserId;
  const assignedUsername = record.assignedUsername;
  return {
    ...normalizeMailbox(raw),
    assignedUserId: typeof assignedUserId === "string" ? assignedUserId : null,
    assignedUsername: typeof assignedUsername === "string" ? assignedUsername : null,
  };
}

function normalizeProviderType(raw: unknown): ProviderTypeView {
  const record = isRecord(raw) ? raw : {};
  const type = readString(record, "type");
  const fallback = PROVIDER_TYPE_FALLBACK[type];
  return {
    type,
    label: readString(record, "label") || fallback?.label || type,
    kind: readKind(record.kind, fallback?.kind ?? "temp"),
    defaultBaseUrl: readString(record, "defaultBaseUrl") || fallback?.defaultBaseUrl || "",
    requiresKey: typeof record.requiresKey === "boolean" ? record.requiresKey : (fallback?.requiresKey ?? true),
    configFields: readConfigFields(record.configFields, fallback?.configFields ?? ["baseUrl", "apiKey"]),
  };
}

function normalizeProvider(raw: unknown): ProviderView {
  const record = isRecord(raw) ? raw : {};
  const type = readString(record, "type");
  const fallback = PROVIDER_TYPE_FALLBACK[type];
  const keyMode: KeyMode = record.keyMode === "personal" ? "personal" : "public";
  return {
    id: readString(record, "id"),
    name: readString(record, "name") || fallback?.label || type,
    type,
    baseUrl: readString(record, "baseUrl"),
    hasKey: record.hasKey === true,
    keyCount: readKeyCount(record),
    enabled: record.enabled !== false,
    mailboxCount: readNumber(record, "mailboxCount"),
    keyMode,
    typeLabel: readString(record, "typeLabel") || fallback?.label || type,
    kind: readKind(record.kind, fallback?.kind ?? "temp"),
    meta: readMeta(record.meta),
  };
}

function normalizeProviderOption(raw: unknown): ProviderOption {
  const record = isRecord(raw) ? raw : {};
  const type = readString(record, "type");
  const fallback = PROVIDER_TYPE_FALLBACK[type];
  return {
    id: readString(record, "id"),
    name: readString(record, "name") || fallback?.label || type,
    type,
    typeLabel: readString(record, "typeLabel") || fallback?.label || type,
    kind: readKind(record.kind, fallback?.kind ?? "temp"),
    supportsImport: record.supportsImport === true,
    supportsGenerate: record.supportsGenerate === true,
    domain: readString(record, "domain"),
  };
}

function normalizeMailbox(raw: unknown): MailboxView {
  const record = isRecord(raw) ? raw : {};
  const statusRaw = readString(record, "status");
  const status: MailboxStatus =
    statusRaw === "assigned" || statusRaw === "disabled" ? statusRaw : "available";
  const assignedAt = record.assignedAt;
  const providerId = readString(record, "providerId");
  // kind 缺失时：Outlook 行（providerId 为空）按 "outlook" 兜底；其余交给 providerId 反查。
  const kind = readOptionalKind(record.kind) ?? (providerId === "" ? "outlook" : undefined);
  return {
    id: readString(record, "id"),
    email: readString(record, "email"),
    providerId,
    providerName: readString(record, "providerName"),
    domain: readString(record, "domain"),
    remark: readString(record, "remark"),
    status,
    ...(kind === undefined ? {} : { kind }),
    tags: readStringArray(record, "tags"),
    quotaExempt: record.quotaExempt === true,
    assignedAt: typeof assignedAt === "string" ? assignedAt : null,
    createdAt: readString(record, "createdAt"),
  };
}

/* ------------------------------ 认证 ------------------------------ */

export async function login(input: LoginInput): Promise<SessionUser> {
  const raw = await request<unknown>("/api/auth/login", {
    method: "POST",
    body: input,
    unauthorizedAsApiError: true,
  });
  return normalizeSessionUser(raw);
}

export function logout(): Promise<void> {
  return request<void>("/api/auth/logout", { method: "POST" });
}

export async function fetchMe(signal?: AbortSignal): Promise<SessionUser> {
  const raw = await request<unknown>("/api/auth/me", { signal });
  return normalizeSessionUser(raw);
}

export function changePassword(input: ChangePasswordInput): Promise<void> {
  return request<void>("/api/auth/password", { method: "POST", body: input });
}

/* ---------------------------- 普通用户 ---------------------------- */

export async function myMailboxes(signal?: AbortSignal): Promise<MailboxView[]> {
  const raw = await request<unknown>("/api/me/mailboxes", { signal });
  return Array.isArray(raw) ? raw.map(normalizeMailbox) : [];
}

export async function claimMailbox(): Promise<ClaimMailboxResult> {
  const raw = await request<unknown>("/api/me/mailboxes/claim", { method: "POST", body: {} });
  const record = isRecord(raw) ? raw : {};
  return { mailbox: normalizeMailbox(record.mailbox) };
}

export function releaseMailbox(id: string): Promise<void> {
  return request<void>(`/api/me/mailboxes/${encodeURIComponent(id)}/release`, { method: "POST" });
}

/** 用户端：设置邮箱标签（已注册 GPT 等），返回保存后的标签集合 */
export async function updateMyMailboxTags(id: string, tags: string[]): Promise<string[]> {
  const raw = await request<unknown>(`/api/me/mailboxes/${encodeURIComponent(id)}/tags`, {
    method: "PATCH",
    body: { tags },
  });
  return readStringArray(isRecord(raw) ? raw : {}, "tags");
}

export function myMessages(mailboxId: string, signal?: AbortSignal): Promise<MessageSummary[]> {
  return request<MessageSummary[]>(`/api/me/mailboxes/${encodeURIComponent(mailboxId)}/messages`, { signal });
}

export function myMessage(
  mailboxId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageDetail> {
  return request<MessageDetail>(
    `/api/me/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
    { signal },
  );
}

export function deleteMyMessage(mailboxId: string, messageId: string): Promise<void> {
  return request<void>(
    `/api/me/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
}

export function clearMyMessages(mailboxId: string): Promise<void> {
  return request<void>(`/api/me/mailboxes/${encodeURIComponent(mailboxId)}/messages`, {
    method: "DELETE",
  });
}

/** v2：用户可用服务商（不含密钥） */
export async function myProviders(signal?: AbortSignal): Promise<ProviderOption[]> {
  const raw = await request<unknown>("/api/me/providers", { signal });
  return Array.isArray(raw) ? raw.map(normalizeProviderOption) : [];
}

/** v2：用户自助导入已有地址 */
export async function importMyMailboxes(input: MyImportMailboxInput): Promise<MyImportMailboxResult> {
  const raw = await request<unknown>("/api/me/mailboxes/import", { method: "POST", body: input });
  const record = isRecord(raw) ? raw : {};
  return {
    imported: readNumber(record, "imported"),
    skipped: readNumber(record, "skipped"),
    quotaSkipped: readNumber(record, "quotaSkipped"),
    errors: readStringArray(record, "errors"),
  };
}

/** v2：用户自助生成新地址 */
export async function generateMyMailboxes(
  input: MyGenerateMailboxInput,
): Promise<MyGenerateMailboxResult> {
  const raw = await request<unknown>("/api/me/mailboxes/generate", { method: "POST", body: input });
  const record = isRecord(raw) ? raw : {};
  const list = record.mailboxes;
  return {
    mailboxes: Array.isArray(list) ? list.map(normalizeMailbox) : [],
    errors: readStringArray(record, "errors"),
  };
}

/** v2：统一「获取邮箱」——按类型领取 Outlook 或生成域名 / 临时地址 */
export async function acquireMailbox(input: AcquireMailboxInput): Promise<AcquireMailboxResult> {
  const raw = await request<unknown>("/api/me/mailboxes/acquire", { method: "POST", body: input });
  const record = isRecord(raw) ? raw : {};
  return {
    mailbox: normalizeMailbox(record.mailbox),
    kind: readKind(record.kind, input.kind),
  };
}

/* ----------------------------- 管理员 ----------------------------- */

export function adminOverview(signal?: AbortSignal): Promise<Overview> {
  return request<Overview>("/api/admin/overview", { signal });
}

/** 管理端统计：收信趋势 / Top 邮箱 / 各类规模，字段缺失时统一兜底为 0 或 [] */
export async function adminStats(signal?: AbortSignal): Promise<AdminStats> {
  const raw = await request<unknown>("/api/admin/stats", { signal });
  const record = isRecord(raw) ? raw : {};
  const boxes = isRecord(record.mailboxes) ? record.mailboxes : {};
  const messages = isRecord(record.messages) ? record.messages : {};
  const byKind = isRecord(messages.byKind) ? messages.byKind : {};
  const providersRaw = isRecord(record.providers) ? record.providers : {};
  const usersRaw = isRecord(record.users) ? record.users : {};
  const dailyRaw = record.daily;
  const topRaw = record.topMailboxes;
  return {
    mailboxes: {
      outlook: readNumber(boxes, "outlook"),
      domain: readNumber(boxes, "domain"),
      temp: readNumber(boxes, "temp"),
      total: readNumber(boxes, "total"),
    },
    messages: {
      total: readNumber(messages, "total"),
      today: readNumber(messages, "today"),
      last7d: readNumber(messages, "last7d"),
      byKind: {
        outlook: readNumber(byKind, "outlook"),
        domain: readNumber(byKind, "domain"),
        temp: readNumber(byKind, "temp"),
      },
    },
    daily: Array.isArray(dailyRaw)
      ? dailyRaw
          .filter(isRecord)
          .map((item) => ({ date: readString(item, "date"), count: readNumber(item, "count") }))
      : [],
    topMailboxes: Array.isArray(topRaw)
      ? topRaw
          .filter(isRecord)
          .map((item) => ({
            email: readString(item, "email"),
            kind: readKind(item.kind, "outlook"),
            count: readNumber(item, "count"),
          }))
      : [],
    claimsToday: readNumber(record, "claimsToday"),
    providers: { total: readNumber(providersRaw, "total"), enabled: readNumber(providersRaw, "enabled") },
    users: { total: readNumber(usersRaw, "total"), active: readNumber(usersRaw, "active") },
  };
}

export async function adminUsers(q?: string, signal?: AbortSignal): Promise<AdminUserView[]> {
  const raw = await request<unknown>(withQuery("/api/admin/users", { q }), { signal });
  return Array.isArray(raw) ? raw.map(normalizeAdminUser) : [];
}

export async function createUser(input: CreateUserInput): Promise<AdminUserView> {
  const raw = await request<unknown>("/api/admin/users", { method: "POST", body: input });
  return normalizeAdminUser(raw);
}

export async function updateUser(id: string, patch: UpdateUserInput): Promise<AdminUserView> {
  const raw = await request<unknown>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  return normalizeAdminUser(raw);
}

/** 管理员重置某用户的三类已用额度（已用只增不减，只能管理员重置） */
export function resetUserUsage(id: string): Promise<AdminUserView> {
  return updateUser(id, { resetUsage: true });
}

/** Outlook 账号导入（邮箱----密码----clientId----refreshToken[----备注]） */
export async function importOutlookAccounts(input: ImportOutlookInput): Promise<ImportOutlookResult> {
  const raw = await request<unknown>("/api/admin/outlook/import", { method: "POST", body: input });
  const record = isRecord(raw) ? raw : {};
  return {
    imported: readNumber(record, "imported"),
    skipped: readNumber(record, "skipped"),
    assigned: readNumber(record, "assigned"),
    errors: readStringArray(record, "errors"),
  };
}

export function deleteUser(id: string): Promise<void> {
  return request<void>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function userMailboxes(id: string, signal?: AbortSignal): Promise<AdminMailboxView[]> {
  return request<AdminMailboxView[]>(`/api/admin/users/${encodeURIComponent(id)}/mailboxes`, {
    signal,
  });
}

export async function adminMailboxes(
  params: { status?: string; q?: string; kind?: string } = {},
  signal?: AbortSignal,
): Promise<AdminMailboxView[]> {
  const raw = await request<unknown>(withQuery("/api/admin/mailboxes", params), { signal });
  return Array.isArray(raw) ? raw.map(normalizeAdminMailbox) : [];
}

export function generateMailboxes(input: GenerateMailboxInput): Promise<GenerateMailboxResult> {
  return request<GenerateMailboxResult>("/api/admin/mailboxes/generate", {
    method: "POST",
    body: input,
  });
}

export function importMailboxes(input: ImportMailboxInput): Promise<ImportMailboxResult> {
  return request<ImportMailboxResult>("/api/admin/mailboxes/import", {
    method: "POST",
    body: input,
  });
}

export function updateMailbox(
  id: string,
  patch: { remark?: string; status?: string },
): Promise<AdminMailboxView> {
  return request<AdminMailboxView>(`/api/admin/mailboxes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}

/** 管理端：设置邮箱标签 */
export async function updateAdminMailboxTags(id: string, tags: string[]): Promise<string[]> {
  const raw = await request<unknown>(`/api/admin/mailboxes/${encodeURIComponent(id)}/tags`, {
    method: "PATCH",
    body: { tags },
  });
  return readStringArray(isRecord(raw) ? raw : {}, "tags");
}

export function assignMailbox(id: string, userId: string | null): Promise<AdminMailboxView> {
  return request<AdminMailboxView>(`/api/admin/mailboxes/${encodeURIComponent(id)}/assign`, {
    method: "POST",
    body: { userId },
  });
}

/** v2：邮箱池批量操作（delete / disable / enable / assign / unassign） */
export async function bulkMailboxes(input: BulkMailboxInput): Promise<BulkMailboxResult> {
  const raw = await request<unknown>("/api/admin/mailboxes/bulk", { method: "POST", body: input });
  const record = isRecord(raw) ? raw : {};
  return {
    affected: readNumber(record, "affected"),
    skipped: readNumber(record, "skipped"),
    errors: readStringArray(record, "errors"),
  };
}

export function bulkDeleteMailboxes(ids: string[]): Promise<BulkDeleteResult> {
  return request<BulkDeleteResult>("/api/admin/mailboxes/bulk-delete", {
    method: "POST",
    body: { ids },
  });
}

export function deleteMailbox(id: string): Promise<void> {
  return request<void>(`/api/admin/mailboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function adminMessages(mailboxId: string, signal?: AbortSignal): Promise<MessageSummary[]> {
  return request<MessageSummary[]>(
    `/api/admin/mailboxes/${encodeURIComponent(mailboxId)}/messages`,
    { signal },
  );
}

export function adminMessage(
  mailboxId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageDetail> {
  return request<MessageDetail>(
    `/api/admin/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
    { signal },
  );
}

export async function providerTypes(signal?: AbortSignal): Promise<ProviderTypeView[]> {
  const raw = await request<unknown>("/api/admin/provider-types", { signal });
  return Array.isArray(raw) ? raw.map(normalizeProviderType) : [];
}

export async function providers(signal?: AbortSignal): Promise<ProviderView[]> {
  const raw = await request<unknown>("/api/admin/providers", { signal });
  return Array.isArray(raw) ? raw.map(normalizeProvider) : [];
}

export async function createProvider(input: CreateProviderInput): Promise<ProviderView[]> {
  const raw = await request<unknown>("/api/admin/providers", { method: "POST", body: input });
  return Array.isArray(raw) ? raw.map(normalizeProvider) : [];
}

export async function deleteProvider(id: string): Promise<ProviderView[]> {
  const raw = await request<unknown>(`/api/admin/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return Array.isArray(raw) ? raw.map(normalizeProvider) : [];
}

export function refreshProviderKeys(): Promise<RefreshKeysResult> {
  return request<RefreshKeysResult>("/api/admin/providers/refresh-keys", { method: "POST" });
}

export function providerDomains(id: string, signal?: AbortSignal): Promise<DomainEntry[]> {
  return request<DomainEntry[]>(`/api/admin/providers/${encodeURIComponent(id)}/domains`, {
    signal,
  });
}

/* ---------------------------- 在线播放 ---------------------------- */

export function onlinePlayPlatforms(signal?: AbortSignal): Promise<OnlinePlatform[]> {
  return request<OnlinePlatform[]>("/api/me/online-play/platforms", { signal });
}

export function onlinePlayHosts(platform: string, signal?: AbortSignal): Promise<OnlineHost[]> {
  return request<OnlineHost[]>(
    withQuery("/api/me/online-play/hosts", { platform }),
    { signal },
  );
}
