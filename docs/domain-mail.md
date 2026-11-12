# 域名邮箱后端

MailDeck 的「域名邮箱」是 `kind=domain` 的服务商类型，目前支持两种后端：

| 类型 | 名称 | 说明 |
|---|---|---|
| `imap` | IMAP 域名邮箱 | 自有域 catch-all 转发到某个 IMAP 邮箱，服务端用 IMAP 读信 |
| `cfmail` | Cloudflare 域名邮箱 | CF Email Routing → 自建 Worker 收信入库(D1)，服务端按 Bearer 拉 `/inbox` |
| `cloudmail` | Cloud Mail（域名邮箱 API） | 对接开源 Cloud Mail 用户态 API（如 `dreamhunter2333/cloudflare_temp_email`），登录换 token 后建地址/列信 |

## Cloud Mail（API 方式）

参考 TGBOT 工作区 `app/mail/cloudmail.py` 的实现，协议要点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{email, password}` → `data.token`（**裸 JWT**，请求头 `authorization: <token>`，不加 `Bearer`） |
| GET | `/api/account/list?size=30&accountId=&lastSort=` | 分页列出地址；按 `email` 找 `accountId` |
| POST | `/api/account/add` | `{email}` 在远端建地址；「已存在」视为可用 |
| GET | `/api/email/list?accountId=&size=&full=1&allReceive=0` | 某地址的邮件列表，`data.list[]` |

响应统一 `{code:200, message, data}`；`code !== 200` 视为失败。

### MailDeck 里的配置

「服务商管理 → 新增服务商 → Cloud Mail（域名邮箱 API）」：

- **BaseURL**：Cloud Mail 服务地址（结尾带 `/api` 也可以，会自动去掉）
- **登录邮箱**：Cloud Mail 的账号邮箱
- **密码**：该账号密码（服务端换取 token 并缓存 1 小时，401 时自动重登一次）
- **收信域名**（可选）：多个用逗号分隔；留空则用「登录邮箱所在域」

生成邮箱时会在远端 `POST /api/account/add` 建好地址；列表/详情走 `/api/email/list`。

> 当前 Cloud Mail 后端为只读收信：暂不支持删除单封/清空收件箱（接口未统一，避免误删）。

## Cloudflare Worker 方式（cfmail）

见 [`cloudflare/README.md`](../cloudflare/README.md)：Email Routing catch-all → Worker → D1，
服务端用 `API_TOKEN` 拉 `/inbox`、`/message`(DELETE)。

适合「自己控域、不想运维容器」，且能顺带支持删除与验证码提取。
