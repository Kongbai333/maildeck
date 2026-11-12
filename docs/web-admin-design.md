# MailDeck 网页端（管理员控制台 + 用户取邮箱）设计稿

> 方向调整：不再投入桌面客户端，全部走网页端。服务端从「单用户 + 共享 API Token」升级为
> 「多用户 + 登录会话 + 角色」。管理员负责维护服务商与邮箱池，普通用户登录后自助领取邮箱并读信。

## 1. 角色与主流程

| 角色 | 能做什么 |
| --- | --- |
| `admin` 管理员 | 登录后台：概览、邮箱池（生成/批量导入/分配/回收/停用/删除）、用户管理（新建/改密/停用/配额/删除）、服务商管理（新增/刷新公共 Key/拉取域名/删除）；可查看任意邮箱的邮件 |
| `user` 普通用户 | 登录后「获取邮箱」从池中领取（受配额限制），查看收件箱、读信、下载/清空、释放邮箱、改自己的密码 |

主流程：

1. 管理员首次启动拿到自动生成的 `admin` 初始密码（控制台打印），登录后台。
2. 管理员加服务商（默认已内置 GPTMail 公共 Key 服务商），在「邮箱池」生成 N 个邮箱或批量导入地址。
3. 管理员在「用户管理」新建普通用户（用户名 + 初始密码 + 邮箱配额）。
4. 普通用户登录 →「获取邮箱」领取一个可用邮箱 → 收件箱自动刷新 → 复制地址去注册/收验证码。

## 2. 后端接口契约（已冻结，前端按此实现）

统一响应包：成功 `{ "ok": true, "value": ... }`；失败 `{ "ok": false, "error": { "code": string, "message": string, "retryable": boolean } }`。
`code` 取值：`UNAUTHORIZED`(401) `FORBIDDEN`(403) `INVALID_REQUEST`(400) `NOT_FOUND`(404) `CONFLICT`(409) `RATE_LIMITED`(429) `UNKNOWN`(500)。
所有写操作使用 `Content-Type: application/json`，鉴权走 HttpOnly Cookie `md_session`（`credentials: "same-origin"`）。

### 2.1 类型

```ts
type Role = "admin" | "user";
type UserStatus = "active" | "disabled";
type MailboxStatus = "available" | "assigned" | "disabled";

interface SessionUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  mailboxQuota: number;
}

interface AdminUserView extends SessionUser {
  mailboxCount: number;
  createdAt: string;
  lastLoginAt: string | null;
}

interface MailboxView {
  id: string;
  email: string;
  providerId: string;
  providerName: string;
  domain: string;
  remark: string;
  status: MailboxStatus;
  assignedAt: string | null;
  createdAt: string;
}

interface AdminMailboxView extends MailboxView {
  assignedUserId: string | null;
  assignedUsername: string | null;
}

interface ProviderView {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
  mailboxCount: number;
  keyMode: "public" | "personal";
}

interface ProviderTypeView { type: string; label: string; defaultBaseUrl: string }
interface DomainEntry { domain: string; wildcard: boolean }

interface MessageAddress { name: string; address: string }

interface MessageSummary {
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

interface MessageDetail extends MessageSummary {
  toRecipients: MessageAddress[];
  ccRecipients: MessageAddress[];
  body: { contentType: "html" | "text"; content: string };
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

interface Overview {
  users: { total: number; admins: number; active: number };
  mailboxes: { total: number; available: number; assigned: number; disabled: number };
  providers: { total: number; enabled: number };
  claimsToday: number;
}
```

### 2.2 认证

| 方法 | 路径 | 请求 | 成功返回 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | `{ username, password }` | `SessionUser`（同时下发 Cookie） |
| POST | `/api/auth/logout` | 无 | `{ ok: true }` |
| GET | `/api/auth/me` | 无 | `SessionUser`；未登录返回 401 `UNAUTHORIZED` |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }` | `{ ok: true }` |

登录失败统一 401「用户名或密码错误」；连续失败 5 次锁定 60 秒返回 429 `RATE_LIMITED`；停用账号返回 403「账号已被停用」。

### 2.3 普通用户

| 方法 | 路径 | 请求 | 成功返回 |
| --- | --- | --- | --- |
| GET | `/api/me/mailboxes` | 无 | `MailboxView[]`（我持有的） |
| POST | `/api/me/mailboxes/claim` | `{}` | `{ mailbox: MailboxView }`；配额满/池空返回 409 |
| POST | `/api/me/mailboxes/:id/release` | 无 | `{ ok: true }` |
| GET | `/api/me/mailboxes/:id/messages` | 无 | `MessageSummary[]` |
| GET | `/api/me/mailboxes/:id/messages/:messageId` | 无 | `MessageDetail` |
| DELETE | `/api/me/mailboxes/:id/messages/:messageId` | 无 | `{ deleted: true }` |
| DELETE | `/api/me/mailboxes/:id/messages` | 无 | `{ cleared: true }` |

非本人邮箱一律 404 `NOT_FOUND`「邮箱不存在」。

### 2.4 管理员

| 方法 | 路径 | 请求 | 成功返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | 无 | `Overview` |
| GET | `/api/admin/users?q=` | 无 | `AdminUserView[]` |
| POST | `/api/admin/users` | `{ username, password, role?, mailboxQuota? }` | `AdminUserView` |
| PATCH | `/api/admin/users/:id` | `{ password?, role?, status?, mailboxQuota? }` | `AdminUserView` |
| DELETE | `/api/admin/users/:id` | 无 | `{ ok: true }`（其邮箱自动回到池中） |
| GET | `/api/admin/users/:id/mailboxes` | 无 | `AdminMailboxView[]` |
| GET | `/api/admin/mailboxes?status=&q=` | 无 | `AdminMailboxView[]` |
| POST | `/api/admin/mailboxes/generate` | `{ providerId, prefix?, domain?, count?, remark? }` | `{ created: AdminMailboxView[] }` |
| POST | `/api/admin/mailboxes/import` | `{ providerId, text }` | `{ imported: number; skipped: number; errors: string[] }` |
| PATCH | `/api/admin/mailboxes/:id` | `{ remark?, status? }` | `AdminMailboxView` |
| POST | `/api/admin/mailboxes/:id/assign` | `{ userId: string \| null }` | `AdminMailboxView` |
| POST | `/api/admin/mailboxes/bulk-delete` | `{ ids: string[] }` | `{ deleted: number }` |
| DELETE | `/api/admin/mailboxes/:id` | 无 | `{ ok: true }` |
| GET | `/api/admin/mailboxes/:id/messages` | 无 | `MessageSummary[]` |
| GET | `/api/admin/mailboxes/:id/messages/:messageId` | 无 | `MessageDetail` |
| GET | `/api/admin/provider-types` | 无 | `ProviderTypeView[]` |
| GET | `/api/admin/providers` | 无 | `ProviderView[]` |
| POST | `/api/admin/providers` | `{ name?, type, baseUrl?, apiKey, keyMode? }` | `ProviderView[]` |
| DELETE | `/api/admin/providers/:id` | 无 | `ProviderView[]` |
| POST | `/api/admin/providers/refresh-keys` | 无 | `{ refreshed: number }` |
| GET | `/api/admin/providers/:id/domains` | 无 | `DomainEntry[]` |

批量导入文本格式：每行 `邮箱地址` 或 `邮箱地址,备注`；`#` 开头忽略；空行忽略。最多 2000 行。

## 3. 前端工程

- 目录：`webapp/`（独立 Vite + React 19 + TypeScript 严格模式，复用根目录 `node_modules`，不新增依赖）。
- 构建产物：`webapp/dist`，由服务端在 `/` 提供静态文件（SPA 回退到 `index.html`）。
- 开发：`npm run dev:webapp`（端口 5174，`/api` 代理到 `http://127.0.0.1:8787`）。
- 图标用 `lucide-react`；邮件 HTML 正文用 `dompurify` 清洗后渲染（`dangerouslySetInnerHTML`），禁止 `target` 逃逸。
- 不做第三方路由库：用 `location.hash` 的极简路由（`#/login` `#/admin/overview` `#/admin/mailboxes` `#/admin/users` `#/admin/providers` `#/mailbox`）。

### 3.1 页面与交互要求

- 登录页：品牌区 + 表单，错误提示、提交中禁用、回车提交。
- 应用外壳：左侧导航（按角色显示菜单）+ 顶部栏（当前用户、角色徽章、退出）。移动端折叠为顶部抽屉。
- 管理员 · 概览：四组统计卡片（用户/邮箱/服务商/今日领取），最近邮箱列表。
- 管理员 · 邮箱池：状态筛选 + 搜索 + 批量选择；「生成邮箱」（服务商、前缀、域名下拉、数量）、「批量导入」（文本域）、单行操作（分配/回收/停用/删除/复制/看邮件）；分页或虚拟滚动可选，1000 行内流畅即可。
- 管理员 · 用户：列表 + 新建 + 改配额/角色/状态 + 重置密码 + 删除（二次确认）。
- 管理员 · 服务商：列表 + 新增（类型下拉自动填 BaseURL）+ 刷新公共 Key + 拉取域名预览 + 删除。
- 用户 · 我的邮箱：无邮箱时展示「获取邮箱」大卡片（说明配额）；有邮箱时展示地址卡片（复制/刷新/释放）与收件箱双栏（列表 + 阅读器），10 秒轮询刷新，正文支持 HTML 与纯文本，附件列表可下载（若接口无下载则只显示文件名与大小）。
- 通用：toast 提示、按钮 loading 态、空状态、错误条、确认弹窗、Esc 关闭弹窗、键盘可达。

### 3.2 视觉

- 现代 SaaS 风格，浅色底 `#f6f7fb`，卡片白底圆角 14px、细边框、轻阴影；主色 `#4f46e5`（hover `#4338ca`）；成功 `#059669`、警告 `#d97706`、危险 `#dc2626`；正文 `#0f172a`，次要文字 `#64748b`。
- 字体：`system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。
- 所有文案中文；时间用 `YYYY-MM-DD HH:mm`；空值显示 `—`。

## 4. 实现补充（落地时确定的行为）

- **邮箱状态机**：`available`（可领取）/ `assigned`（已归属）/ `disabled`（停用）。
  - `PATCH /api/admin/mailboxes/:id { status: "disabled" }` 只关闭可领取，**保留归属**；
  - `{ status: "assigned" }` 用于重新启用已分配邮箱（未分配时返回 409）；
  - `{ status: "available" }` 等于回收，清空归属回到池子；
  - 「回收」也可以走 `POST .../assign { userId: null }`。
- **领取顺序**：按 `created_at ASC` 取第一个可用邮箱（FIFO，可预期、便于排查）。
- **释放**：立刻回池；远端收件箱清空是后台任务，可用 `MAILDECK_RELEASE_CLEAR_INBOX=0` 关闭。
- **空 body**：服务端自定义了 JSON 解析器，`DELETE`/无参 `POST` 带 `content-type: application/json` 不再 400。
- **本地联调**：`node scripts/mock-gptmail.mjs` 起一个假 GPTMail（8899），在「服务商」里新增类型 GPTMail、Base URL `http://127.0.0.1:8899`、Key 随意、模式选「个人」，即可在无外网时跑通生成/收信/读信全链路。
- **截图**：`docs/screenshots/web-*.png` 由真实浏览器 + 假服务商数据产出（1440×900 与 500×857 移动端各一组）。

