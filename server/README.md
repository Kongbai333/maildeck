# MailDeck Server（网页端 · 多用户）

服务端负责账号体系、邮箱池、邮件读取、关注记录与网页静态资源托管。浏览器通过会话 Cookie 调用 HTTP API，服务端校验角色、功能权限和资源归属。

| 角色 | 能力 |
| --- | --- |
| 管理员 `admin` | 概览、服务商、三类邮箱池、导入与生成、分配与回收、批量操作，以及用户权限、配额和密码管理 |
| 普通用户 `user` | 获取邮箱、自助导入 Outlook、查看收件箱、读信、按邮箱能力删除/清空邮件、释放邮箱、修改密码；开通在线播放权限后可浏览频道与管理关注 |

## 快速开始

需要 Node.js **22.13.0+**，推荐 **Node.js 24**。以下命令在仓库根目录执行。

```bash
npm install
npm run dev
```

`npm run dev` 等价于 `npm run dev:cloud`，同时启动 API（8787）和网页（5174）。也可在两个终端分别运行 `npm run dev:server` 与 `npm run dev:webapp`。开发页面为 `http://127.0.0.1:5174`。

首次启动自动创建管理员，初始密码打印在服务端日志中。若需指定初始账号密码，在首次启动前设置 `MAILDECK_ADMIN_USERNAME` 和 `MAILDECK_ADMIN_PASSWORD`。

生产运行：

```bash
npm run build
npm start
```

`npm run build` 等价于 `npm run build:cloud`，生成 `webapp/dist` 与 `dist-server`；`npm start` 执行 `node dist-server/server/src/index.js`。服务端只托管 `webapp/dist`，生产网页地址默认为 `http://127.0.0.1:8787`。`npm run start:cloud` 保留为先构建再启动的兼容命令。

## 典型使用流程

1. 管理员在「服务商」配置域名或临时邮箱服务，在「邮箱池」导入 Outlook 账号或生成域名/临时邮箱。
2. 在「用户」建立账号，分别设置 Outlook、域名和临时邮箱配额，并按需开启在线播放权限。
3. 用户通过「获取邮箱」选择类型和数量（网页支持 1～20 个），或自助导入自己的 Outlook 账号；自助导入不占领取配额。
4. 邮箱列表可按类型和标签筛选；收件箱每 10 秒轮询，页面隐藏时暂停。
5. 释放邮箱按现有服务端规则回收，并按配置尝试清空远端收件箱；释放不返还已用额度。管理员可重置用量。
6. 在线播放关注记录按账号保存；网页打开关注主播前重新请求所属平台列表以获取当前地址。

## 环境变量

```text
MAILDECK_HOST=127.0.0.1
MAILDECK_PORT=8787
MAILDECK_DATA_DIR=./data
MAILDECK_MASTER_KEY=              # 32 字节 base64；不填时仅本地开发使用固定 dev key
MAILDECK_ADMIN_USERNAME=admin     # 首次启动创建的管理员用户名
MAILDECK_ADMIN_PASSWORD=          # 留空则随机生成并打印一次
MAILDECK_SESSION_TTL_DAYS=7       # 登录会话有效期
MAILDECK_API_TOKEN=               # 可选：兼容 HTTP 管理接口的 Bearer Token（等价管理员）
MAILDECK_RELEASE_CLEAR_INBOX=1    # 释放邮箱时后台清空远端收件箱
MAILDECK_PROXY_URL=               # 可选 HTTP/HTTPS 代理
MAILDECK_CORS_ORIGINS=http://127.0.0.1:5174,http://localhost:5174
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
- 权限策略集中在[服务入口](src/index.ts)的 `registerAccessPolicy`：
  - 公开：`/api/health`、`/api/auth/login`、`/api/auth/logout`
  - 登录用户：`/api/auth/me`、`/api/auth/password`、`/api/me/*`
  - 管理员：`/api/admin/*`、`/api/auth/device-code/*`，以及兼容 HTTP 管理接口（`/api/accounts`、`/api/mail/*` 等）

## API 概览

主要网页端接口（保持现有 HTTP 契约）：

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

GET    /api/me/online-play/platforms
GET    /api/me/online-play/hosts?platform=
GET    /api/me/online-play/follows
POST   /api/me/online-play/follows       { title, cover, address, platformAddress, platformTitle }
DELETE /api/me/online-play/follows/:id

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

兼容 HTTP 管理接口继续保留在 `/api/accounts`、`/api/mail/*`、`/api/settings`、`/api/groups`、`/api/domain-*`、`/api/auth/device-code/*`。它们沿用既有管理员权限、请求参数和响应契约，详见[服务入口](src/index.ts)。配置的 Bearer Token 可用于兼容管理接口；`/api/me/*` 仍要求账号会话，不接受仅有管理 Token 的身份。

网页批量获取复用现有获取接口；在线播放接口额外检查账号权限，关注列表的查询、保存和删除都按会话账号隔离。

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
| `accounts` / `mail_messages` / … | 微软账号（含 `assigned_user_id`/`assigned_via`，即 Outlook 账号池）与兼容邮件缓存 |
| `online_play_follows` | 按用户保存的主播关注，包含平台、标题、地址与创建时间 |

老库升级是自动的：启动时给 `domain_mailboxes` 补 `assigned_user_id` / `status` / `assigned_at` 三列，
历史生成的邮箱一律按「可用」进入池子。

## 服务商适配器（临时邮箱 / 域名邮箱）

[服务商适配器](src/domain-adapters.ts)定义适配器接口，`DOMAIN_ADAPTERS` 注册可用服务商。新增服务商时实现同一接口并注册，前端「服务商」下拉由 `configFields` 驱动。

下表描述适配器能力；网页邮箱池与个人邮箱仅开放 Outlook 账号导入，域名和临时邮箱使用生成入口。

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

在仓库根目录准备环境变量并启动：

```bash
cp .env.docker.example .env
# 编辑 .env，设置 MAILDECK_MASTER_KEY 与 MAILDECK_ADMIN_PASSWORD

docker compose pull
docker compose up -d
```

PowerShell 可用 `Copy-Item .env.docker.example .env` 完成复制。默认端口为 8787，持久数据挂载到 `/data`。本地构建时，Docker 多阶段构建会在容器内生成网页和服务端产物，无需预先生成宿主机的网页产物。详细步骤见[Docker 部署说明](../DOCKER.md)。

## 代码结构与验证

```text
server/src/   HTTP 路由、账号权限、邮箱池、服务商与数据库服务
shared/       共用类型、契约和纯工具（仓库根目录）
server/mail/  Graph / IMAP、OAuth、邮件解析与传输辅助模块
webapp/       HTTP API 的网页调用方（仓库根目录）
```

在仓库根目录运行：

```bash
npm run typecheck:server
npm run typecheck
npm run lint
npm test
npm run build
```

关注的行为包括登录与会话吊销、角色及邮箱归属隔离、配额和导入规则、邮件缓存，以及兼容 HTTP 管理接口。工程目录整理保持上述业务行为和接口契约。
