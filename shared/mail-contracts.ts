/** Transport-independent contracts shared by the mail services and web clients. */
export const APP_ERROR_MESSAGE_MAX_CHARS = 4_096;
export const DIAGNOSTIC_REQUEST_ID_MAX_CHARS = 1_024;

export type AccountStatus = "untested" | "valid" | "invalid";
export type AppErrorCode =
  | "INVALID_REQUEST"
  | "CANCELED"
  | "STALE_CREDENTIALS"
  | "CREDENTIAL_UNREADABLE"
  | "THROTTLED"
  | "TOKEN_EXPIRED"
  | "INVALID_CLIENT"
  | "IMAP_AUTH_FAILED"
  | "SCOPE_MISSING"
  | "NETWORK_ERROR"
  | "MAIL_PARSE_FAILED"
  | "MAIL_TOO_LARGE"
  | "MAILBOX_NOT_FOUND"
  | "GRAPH_NOT_FOUND"
  | "DEVICE_CODE_EXPIRED"
  | "DEVICE_CODE_DECLINED"
  | "ACCOUNT_NOT_FOUND"
  | "UNKNOWN";

export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  diagnostic?: {
    requestId?: string;
  };
}

export class RequestValidationError extends Error {
  override readonly name = "RequestValidationError";
}

export function isRequestValidationError(error: unknown): error is RequestValidationError {
  return error instanceof RequestValidationError;
}

export interface AccountInput {
  email: string;
  clientId: string;
  refreshToken: string;
  remark?: string;
  group?: string;
  /** 账号标签，和分组分开维护；同一标签可挂在多个账号上。 */
  tags?: string[];
}

export interface AccountUpdateInput {
  id: string;
  email: string;
  clientId: string;
  refreshToken?: string;
  remark?: string;
  group?: string;
  tags?: string[];
}

export interface AccountView {
  id: string;
  email: string;
  clientId: string;
  remark: string;
  group: string;
  tags?: string[];
  authMode?: "graph" | "imap";
  status: AccountStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastRefreshedAt?: string | null;
  lastInboxCount?: number;
  lastMailAt?: string | null;
  lastMailCursor?: string | null;
  inboxFolderId?: string | null;
  graphDeltaLink?: string | null;
  refreshCooldownUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccessTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
  authMode: "graph" | "imap";
}

export interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailMessageSummary {
  id: string;
  subject: string;
  from: MailAddress | null;
  receivedDateTime: string | null;
  sentDateTime: string | null;
  isRead: boolean;
  importance: string;
  hasAttachments: boolean;
  bodyPreview: string;
  webLink: string | null;
}

export interface MailMessageDetail extends MailMessageSummary {
  toRecipients: MailAddress[];
  ccRecipients: MailAddress[];
  body: {
    contentType: string;
    content: string;
  };
}

export interface MailAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

/** IMAP 正文不经 Graph 时，以 supported=false 表示附件列表不可用。 */
export interface MailAttachmentListResult {
  supported: boolean;
  attachments: MailAttachmentMeta[];
}

export interface ListAttachmentsOptions {
  accountId: string;
  messageId: string;
  folderId?: string;
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  accounts: AccountView[];
}

export interface ImportPreviewResult {
  total: number;
  valid: number;
  duplicates: number;
  invalid: number;
  errors: string[];
  warnings: string[];
}

export type TestConnectionResult =
  | { account: AccountView; ok: true; message: string }
  | { account: AccountView | null; ok: false; error: AppErrorPayload };

export type TestFallbackResult =
  | {
      account: AccountView;
      ok: true;
      message: string;
      transport: string;
      count: number;
      elapsedMs: number;
    }
  | { account: null; ok: false; error: AppErrorPayload; elapsedMs: number };

export type TestManyResult =
  | { accountId: string; account: AccountView; ok: true; message: string }
  | { accountId: string; account: AccountView | null; ok: false; error: AppErrorPayload };

export interface RefreshMetrics {
  tokenMs: number;
  mailMs: number;
  cacheMs: number;
  stateMs: number;
  totalMs: number;
  fallback?: string;
}

export type RefreshManyResult =
  | {
      accountId: string;
      ok: true;
      count: number;
      newCount?: number;
      skipped?: boolean;
      metrics?: RefreshMetrics;
    }
  | {
      accountId: string;
      ok: false;
      count: number;
      canceled?: boolean;
      error: AppErrorPayload;
      metrics?: RefreshMetrics;
    };

export interface ListMessagesOptions {
  accountId: string;
  top?: number;
  skip?: number;
  search?: string;
  forceRefresh?: boolean;
  cursor?: string;
  since?: string | null;
  folderId?: string;
}

export interface GetMessageOptions {
  accountId: string;
  messageId: string;
  folderId?: string;
}

/** 定时刷新范围：all=全部可用账号；recent=最近 7 天收到过邮件的账号。 */
export type RefreshScope = "all" | "recent";

export interface MailListResult {
  messages: MailMessageSummary[];
  nextCursor: string | null;
  totalCount?: number;
  /** 网络或凭据失败时，标记列表来自过期缓存。 */
  stale?: boolean;
  staleReason?: string;
}

export interface MailCacheStats {
  accountCount: number;
  messageCount: number;
  bodyCount: number;
  approximateBytes: number;
}

export interface AppSettings {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  proxyUsername: string;
  proxyHasPassword: boolean;
  proxySupported: boolean;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: number;
  refreshScope: RefreshScope;
}

export interface AppSettingsUpdate {
  cacheMessages?: boolean;
  cacheBodies?: boolean;
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
  batchConcurrency?: number;
  hotmailFallbackEnabled?: boolean;
  autoRefreshEnabled?: boolean;
  autoRefreshIntervalMinutes?: number;
  refreshScope?: RefreshScope;
}

export interface DeviceCodeSessionView {
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  clientId: string;
}

export type DeviceCodeFailureCode = "DEVICE_CODE_EXPIRED" | "DEVICE_CODE_DECLINED" | "NETWORK_ERROR" | "UNKNOWN";

export type DeviceCodeStateEvent =
  | ({ phase: "waiting" } & DeviceCodeSessionView)
  | { phase: "authorized"; clientId: string; refreshToken: string; email: string | null; scope: string }
  | { phase: "failed"; code: DeviceCodeFailureCode; message: string }
  | { phase: "canceled" };
