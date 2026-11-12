/**
 * 与 docs/web-admin-design.md §2.1 + docs/web-admin-design-v2.md §1 一致的前端类型。
 * 接口契约已冻结，这里只做类型声明，不改字段名。
 */

export type Role = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type MailboxStatus = "available" | "assigned" | "disabled";
export type KeyMode = "public" | "personal";

/** 临时邮箱 / 域名邮箱 / Outlook（邮箱池只收 Outlook） */
export type ProviderKind = "temp" | "domain" | "outlook";

/** 三类邮箱配额：上限（quotas）与已用（quotaUsage / mailboxCounts）共用同一结构 */
export interface QuotaBuckets {
  outlook: number;
  domain: number;
  temp: number;
}

/** 服务商配置表单里可能出现的字段（v2 §1.1） */
export type ProviderConfigField =
  | "baseUrl"
  | "apiKey"
  | "keyMode"
  | "host"
  | "port"
  | "secure"
  | "user"
  | "domain";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  /** 旧字段：等价于 Outlook 配额，保留兼容 */
  mailboxQuota: number;
  /** 三类配额上限；缺失时前端退回 mailboxQuota */
  quotas?: QuotaBuckets;
  /** 三类已用数量；缺失时前端按邮箱列表自行统计 */
  quotaUsage?: QuotaBuckets;
  /** 是否有「在线播放」权限（管理员按账号分配） */
  canOnlinePlay?: boolean;
}

export interface AdminUserView extends SessionUser {
  mailboxCount: number;
  /** 三类已用数量（管理端列表展示） */
  mailboxCounts?: QuotaBuckets;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface MailboxView {
  id: string;
  email: string;
  providerId: string;
  providerName: string;
  domain: string;
  remark: string;
  status: MailboxStatus;
  /** 所属服务商类别；缺失时前端用 providerId 反查 */
  kind?: ProviderKind;
  /** 用户自定义标签（如「已注册 GPT」），缺失按 [] 兜底 */
  tags: string[];
  /** true = 用户自助导入的 Outlook 账号，不占配额（缺失按 false） */
  quotaExempt: boolean;
  assignedAt: string | null;
  createdAt: string;
}

export interface AdminMailboxView extends MailboxView {
  assignedUserId: string | null;
  assignedUsername: string | null;
}

export interface ProviderView {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  hasKey: boolean;
  /** 已配置的 Key 数量（多 Key 服务商可能 >1；缺失时按 hasKey 兜底） */
  keyCount: number;
  enabled: boolean;
  mailboxCount: number;
  keyMode: KeyMode;
  /** v2：类型显示名 */
  typeLabel: string;
  /** v2：临时邮箱 / 域名邮箱 */
  kind: ProviderKind;
  /** v2：imap 专用 { host, port, secure, user, domain } */
  meta: Record<string, string>;
}

export interface ProviderTypeView {
  type: string;
  label: string;
  /** v2：临时邮箱 / 域名邮箱 */
  kind: ProviderKind;
  defaultBaseUrl: string;
  /** v2：创建时是否必须填 API Key（imap 是密码） */
  requiresKey: boolean;
  /** v2：该类型需要渲染的表单字段 */
  configFields: ProviderConfigField[];
}

/** v2：用户侧服务商选项，不含任何密钥 */
export interface ProviderOption {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  kind: ProviderKind;
  /** 可粘贴已有地址 */
  supportsImport: boolean;
  /** 可由服务端生成新地址 */
  supportsGenerate: boolean;
  /** 域名邮箱的 catch-all 域名，可为空 */
  domain: string;
}

export interface DomainEntry {
  domain: string;
  wildcard: boolean;
}

export interface MessageAddress {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  subject: string;
  from: MessageAddress | null;
  receivedDateTime: string | null;
  sentDateTime: string | null;
  isRead: boolean;
  importance: string;
  hasAttachments: boolean;
  bodyPreview: string;
  webLink: string | null;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageBody {
  contentType: "html" | "text";
  content: string;
}

export interface MessageDetail extends MessageSummary {
  toRecipients: MessageAddress[];
  ccRecipients: MessageAddress[];
  body: MessageBody;
  attachments: MessageAttachment[];
}

export interface Overview {
  users: { total: number; admins: number; active: number };
  mailboxes: { total: number; available: number; assigned: number; disabled: number };
  providers: { total: number; enabled: number };
  claimsToday: number;
}

/** 管理端统计（GET /api/admin/stats）：收信趋势、Top 邮箱与整体规模 */
export interface AdminStats {
  mailboxes: { outlook: number; domain: number; temp: number; total: number };
  messages: {
    total: number;
    today: number;
    last7d: number;
    byKind: QuotaBuckets;
  };
  /** 最近 7 天（含今天）的每日收信数 */
  daily: Array<{ date: string; count: number }>;
  /** 收信最多的邮箱 Top10 */
  topMailboxes: Array<{ email: string; kind: ProviderKind; count: number }>;
  claimsToday: number;
  providers: { total: number; enabled: number };
  users: { total: number; active: number };
}

/* ---------- 请求体 ---------- */

export interface LoginInput {
  username: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: Role;
  mailboxQuota?: number;
  /** 三类配额上限（优先于 mailboxQuota） */
  quotas?: QuotaBuckets;
  /** 在线播放权限 */
  canOnlinePlay?: boolean;
}

export interface UpdateUserInput {
  password?: string;
  role?: Role;
  status?: UserStatus;
  mailboxQuota?: number;
  quotas?: QuotaBuckets;
  /** true = 把三类已用额度清零（已用额度只增不减，只有管理员能重置） */
  resetUsage?: boolean;
  /** 在线播放权限开关 */
  canOnlinePlay?: boolean;
}

export interface GenerateMailboxInput {
  providerId: string;
  prefix?: string;
  domain?: string;
  count?: number;
  remark?: string;
}

export interface ImportMailboxInput {
  providerId: string;
  text: string;
}

export interface ImportMailboxResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface CreateProviderInput {
  name?: string;
  type: string;
  baseUrl?: string;
  /** mailtm 等无需 Key 的类型可省略；多 Key 场景传第一把以兼容旧字段 */
  apiKey?: string;
  /** 多 Key 服务商（如 yyds）：每行一把，服务端自动轮换 */
  apiKeys?: string[];
  keyMode?: KeyMode;
  /** v2：仅 imap 使用 { host, port, secure: "1"|"0", user, domain } */
  meta?: Record<string, string>;
}

/* ---------- v2：普通用户自助导入 / 生成 ---------- */

/** 用户自助导入：只导入 Outlook 账号，受 outlook 配额限制 */
export interface MyImportMailboxInput {
  text: string;
}

export interface MyImportMailboxResult {
  imported: number;
  skipped: number;
  /** 因配额不足没放进去的数量 */
  quotaSkipped: number;
  errors: string[];
}

export interface MyGenerateMailboxInput {
  providerId: string;
  prefix?: string;
  count?: number;
}

export interface MyGenerateMailboxResult {
  mailboxes: MailboxView[];
  errors: string[];
}

/* ---------- v2：统一「获取邮箱」（领取 Outlook / 生成域名、临时） ---------- */

export interface AcquireMailboxInput {
  kind: ProviderKind;
  /** 域名 / 临时邮箱可选指定服务商；不传则服务端挑第一个可用 */
  providerId?: string;
}

export interface AcquireMailboxResult {
  mailbox: MailboxView;
  kind: ProviderKind;
}

/* ---------- v2：邮箱池批量操作 ---------- */

export type BulkMailboxAction = "delete" | "disable" | "enable" | "assign" | "unassign";

export interface BulkMailboxInput {
  action: BulkMailboxAction;
  ids: string[];
  /** action = assign 时必填 */
  userId?: string;
}

export interface BulkMailboxResult {
  affected: number;
  skipped: number;
  errors: string[];
}

/* ---------- Outlook 账号导入（虚拟 kind，不是服务商） ---------- */

export interface ImportOutlookInput {
  text: string;
  /** 可选的分配目标用户；不传 / null 表示导入后留在 Outlook 账号池 */
  userId?: string | null;
}

export interface ImportOutlookResult {
  imported: number;
  skipped: number;
  /** 导入时直接分配给指定用户的账号数（默认 0） */
  assigned: number;
  errors: string[];
}

/* ---------- 响应体 ---------- */

export interface ClaimMailboxResult {
  mailbox: MailboxView;
}

export interface GenerateMailboxResult {
  created: AdminMailboxView[];
}

export interface BulkDeleteResult {
  deleted: number;
}

export interface RefreshKeysResult {
  refreshed: number;
}

/* ---------- 在线播放 ---------- */

export interface OnlinePlatform {
  title: string;
  cover: string;
  /** 平台子列表文件名，如 jsonkawayi.txt */
  address: string;
  count: number;
}

export interface OnlineHost {
  title: string;
  cover: string;
  /** 直播流地址（.flv / .m3u8 / 网页） */
  address: string;
}
