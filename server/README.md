# MailDeck Server（网页端 · 多用户）

MailDeck 现在只有一个形态：**网页端**。服务端负责账号体系、邮箱池、邮件读取与静态页面托管，
浏览器打开服务地址即可使用，不再依赖桌面客户端。

角色：

| 角色 | 能力 |
| --- | --- |
| 管理员 `admin` | 控制台：概览、服务商（API Key / 公共 Key 刷新 / 域名）、邮箱池（生成、批量导入、分配、回收、停用、删除、查看任意邮箱邮件）、用户（新建、改配额、改角色、停用、重置密码、删除） |
| 普通用户 `user` | 登录后从邮箱池「获取邮箱」，查看收件箱、读信、删除/清空邮件、释放邮箱、修改自己的密码 |

## 快速开始

```powershell
npm install

# 终端 1：API（8787）
npm run dev:server

# 终端 2：网页端（5174，/api 自动代理到 8787）
npm run dev:webapp
```

打开 `http://127.0.0.1:5174`。首次启动会自动创建管理员账号，密码打印在服务端日志里：

```text
==================== MailDeck 初始化 ====================
已创建管理员账号：admin
初始密码（仅显示这一次，请立即登录修改）：xxxxxxxxxxxx
========================================================
```

想固定密码就设置 `MAILDECK_ADMIN_PASSWORD` 后再启动。

生产形态（先构建，再由服务端托管静态页面）：

```powershell
npm run build:cloud          # webapp → webapp/dist，server → dist-server
node dist-server/server/src/index.js
# 打开 http://127.0.0.1:8787
```

服务端启动时会优先托管 `webapp/dist`，没有时才回退到旧的 `dist`。

## 典型使用流程

1. 管理员登录 → 「服务商」确认已有 GPTMail（首次启动会自动补一个公共 Key 服务商）。
2. 「邮箱池」→ 生成邮箱（选服务商、前缀、域名、数量）或批量导入地址（每行 `地址` 或 `地址,备注`）。
3. 「用户」→ 新建普通用户，设置邮箱配额（默认 1）。
4. 普通用户登录 → 「获取邮箱」领取一个可用邮箱 → 收件箱 10 秒轮询 → 复制地址收验证码。
5. 用完点「释放」，邮箱回到池子（后台会尽力清空远端收件箱，避免下一个人看到验证码）。

## 环境变量

```text
MAILDECK_HOST=127.0.0.1
MAILDECK_PORT=8787
MAILDECK_DATA_DIR=./data
MAILDECK_MASTER_KEY=              # 32 字节 base64；不填时仅本地开发使用固定 dev key
MAILDECK_ADMIN_USERNAME=admin     # 首次启动创建的管理员用户名
MAILDECK_ADMIN_PASSWORD=          # 留空则随机生成并打印一次
MAILDECK_SESSION_TTL_DAYS=7       # 登录会话有效期
MAILDECK_API_TOKEN=               # 可选：兼容旧客户端的 Bearer Token（等价管理员）
MAILDECK_RELEASE_CLEAR_INBOX=1    # 释放邮箱时后台清空远端收件箱
MAILDECK_PROXY_URL=               # 可选 HTTP/HTTPS 代理
MAILDECK_CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174
```

生成主密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

生产环境必须设置自己的 `MAILDECK_MASTER_KEY` 并单独备份：数据库里只有密文。反向代理下若使用 HTTPS，
建议确保转发 `X-Forwarded-Proto`，服务端会据此给会话 Cookie 加 `Secure`。

## 认证与权限

- 登录：`POST /api/auth/login`，成功下发 HttpOnly Cookie `md_session`（SameSite=Lax，默认 7 天）。
- 密码：scrypt（N=16384, r=8, p=1）+ 随机盐，参数随密文保存。
- 会话：数据库存 `sha256(token)`，改密、停用、删除用户都会立即吊销该用户所有会话。
- 登录失败 5 次锁定 60 秒（按 IP + 用户名）。
- 权限策略集中在 `server/src/index.ts` 的 `registerAccessPolicy`：
  - 公开：`/api/health`、`/api/auth/login`、`/api/auth/logout`
  - 登录用户：`/api/auth/me`、`/api/auth/password`、`/api/me/*`
  - 管理员：`/api/admin/*`、`/api/auth/device-code/*`，以及所有遗留单用户接口（`/api/accounts`、`/api/mail/*` 等）

## API 概览

网页端接口（前端只用到这些）：

```text
POST   /api/auth/login                 { username, password }
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/password              { currentPassword, newPassword }

GET    /api/me/providers                # 可用服务商（不含密钥）
GET    /api/me/mailboxes
POST   /api/me/mailboxes/acquire       { kind: outlook|domain|temp, providerId? }  # 统一获取
POST   /api/me/mailboxes/claim
POST   /api/me/mailboxes/import         { text }  # 只导入 Outlook 账号，不占配额
POST   /api/me/mailboxes/generate       { providerId, prefix?, count? }
POST   /api/me/mailboxes/:id/release
GET    /api/me/mailboxes/:id/messages
GET    /api/me/mailboxes/:id/messages/:messageId
DELETE /api/me/mailboxes/:id/messages/:messageId
DELETE /api/me/mailboxes/:id/messages

GET    /api/admin/overview
GET    /api/admin/users?q=
POST   /api/admin/users                { username, password, role?, mailboxQuota? }
PATCH  /api/admin/users/:id            { password?, role?, status?, mailboxQuota?, quotas?, resetUsage? }
DELETE /api/admin/users/:id
GET    /api/admin/users/:id/mailboxes

GET    /api/admin/mailboxes?status=&q=&kind=  # kind=outlook(默认)/domain/temp/all
POST   /api/admin/mailboxes/generate   { providerId, prefix?, domain?, count?, remark? }  # 域名/临时邮箱生成
POST   /api/admin/mailboxes/import     { providerId, text }  # 已废弃：域名/临时邮箱不再支持导入
POST   /api/admin/outlook/import       { text, userId? }  # 微软账号批量导入，可选直接分配给用户
GET    /api/admin/stats                # 统计：邮箱规模 / 收信量 / 7 天趋势 / Top10
PATCH  /api/admin/mailboxes/:id/tags   { tags }
PATCH  /api/me/mailboxes/:id/tags      { tags }
PATCH  /api/admin/mailboxes/:id        { remark?, status? }
POST   /api/admin/mailboxes/:id/assign { userId: string | null }
POST   /api/admin/mailboxes/bulk       { action: delete|disable|enable|assign|unassign, ids, userId? }
POST   /api/admin/mailboxes/bulk-delete{ ids: string[] }
DELETE /api/admin/mailboxes/:id
GET    /api/admin/mailboxes/:id/messages
GET    /api/admin/mailboxes/:id/messages/:messageId

GET    /api/admin/provider-types
GET    /api/admin/providers
POST   /api/admin/providers            { name?, type, baseUrl?, apiKey, keyMode? }
DELETE /api/admin/providers/:id
POST   /api/admin/providers/refresh-keys
GET    /api/admin/providers/:id/domains
```

统一响应：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, retryable } }`；
`code` 取值 `UNAUTHORIZED` `FORBIDDEN` `INVALID_REQUEST` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `UPSTREAM` `UNKNOWN`。

遗留接口（旧桌面端/单用户模式，仍可用，仅管理员）保留在 `/api/accounts`、`/api/mail/*`、`/api/settings`、
`/api/groups`、`/api/domain-*`、`/api/auth/device-code/*`，详见 `server/src/index.ts`。

## 数据模型

SQLite（`data/maildeck-server.db`）：

| 表 | 说明 |
| --- | --- |
| `users` | 账号、角色、状态、邮箱配额、scrypt 口令散列 |
| `sessions` | 会话（只存 token 的 sha256） |
| `domain_providers` | 邮箱服务商（API Key 用主密钥 AES-GCM 加密） |
| `domain_mailboxes` | 邮箱池：地址、状态 `available/assigned/disabled`、归属用户、备注 |
| `mailbox_events` | 领取/释放/分配/导入/删除审计流水（概览的「今日领取」来自这里） |
| `mailbox_message_cache` / `mailbox_detail_cache` / `mailbox_list_cache` | 域名/临时邮箱的邮件列表与详情缓存：读到就写入，上游失败自动回退 |
| `accounts` / `mail_messages` / … | 微软账号（含 `assigned_user_id`/`assigned_via`，即 Outlook 账号池）与遗留邮件缓存 |

老库升级是自动的：启动时给 `domain_mailboxes` 补 `assigned_user_id` / `status` / `assigned_at` 三列，
历史生成的邮箱一律按「可用」进入池子。

## 服务商适配器（临时邮箱 / 域名邮箱）

`server/src/domain-adapters.ts` 定义适配器接口，`DOMAIN_ADAPTERS` 注册可用服务商。新增网站时实现同一接口并注册，
前端「服务商」下拉会自动出现（字段由 `configFields` 驱动）。

| type | 类型 | 说明 | 生成 | 导入 |
| --- | --- | --- | --- | --- |
| `gptmail` | 临时邮箱 | `https://mail.chatgpt.org.uk`，`X-API-Key`；公共 Key 每日刷新、失效自愈 | ✅ | ✅ |
| `mailtm` | 临时邮箱 | `https://api.mail.tm`；每个地址自动注册账号，口令用主密钥加密存在 `domain_mailboxes.secret_encrypted` | ✅ | ❌ |
| `imap` | 域名邮箱 | 自有域名 catch-all：一个 IMAP 账号收 `*@域名` 的邮件，按收件人过滤；配置 `meta.host/port/secure/user/domain`，密码存 `encrypted_api_key` | ✅（纯别名） | ❌ |
| `yyds` | 临时邮箱 | [YYDS Mail](https://vip.215.im/docs)，`https://maliapi.215.im/v1`，`X-API-Key`；**支持多把 Key**（额外 Key 加密存 `meta.apiKeysEnc`，401/403/429 自动换下一把） | ✅ | ❌ |

GPTMail 的公共测试 Key 每日更换且共享额度，正式使用建议购买个人 Key。服务端启动时会自动补齐公共 Key
服务商并刷新 Key；请求过程中遇到 Key 失效也会自愈重试一次。

本地联调：`node scripts/mock-gptmail.mjs` 会在 8899 同时模拟 GPTMail 与 mail.tm（含 `/domains`、`/accounts`、
`/token`、`/messages`），不连外网也能跑通「生成 → 收信 → 读信 → 删除」。

## Docker

```powershell
cd server
Copy-Item .env.example .env
# 编辑 .env，填入 MAILDECK_MASTER_KEY / MAILDECK_ADMIN_PASSWORD
docker compose up -d --build
```

默认暴露 `8787`。镜像需要 `webapp/dist` 存在，构建前先执行 `npm run build:webapp`。

## 测试

```powershell
npm run typecheck:server
npx vitest run tests/server-web-auth.test.ts tests/server-api.test.ts
```

覆盖：未登录 401、登录/错误密码、角色隔离、领取配额、释放回池、管理员分配、停用吊销会话、
删除用户回收邮箱、批量导入去重与非法行、管理员改密后旧会话失效。
