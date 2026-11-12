# MailDeck 域名邮箱 · Cloudflare 收信服务

MailDeck 的「域名邮箱」支持 **Cloudflare Email Routing + Worker + D1**：把收信和存储放在 Cloudflare，
MailDeck 服务端主动用 Bearer 拉 `/inbox`，不需要服务器有公网回收入口。

```
外部来信 → CF Email Routing(catch-all) → 本 Worker(email) → D1(mails)
MailDeck 服务端 → GET /inbox（Bearer API_TOKEN）→ 展示/取信
```

## 部署步骤

```bash
cd cloudflare
npm i -D wrangler postal-mime

wrangler login
wrangler d1 create maildeck_mail        # 把返回的 database_id 填进 wrangler.toml
wrangler d1 execute maildeck_mail --file=./schema.sql --remote

wrangler secret put API_TOKEN           # 生成一串长随机串，稍后填到 MailDeck
wrangler deploy                          # 记下 https://maildeck-mail.<acct>.workers.dev
```

然后到 Cloudflare 控制台：**Email → Email Routing → 你的域 → Routing rules → Catch-all
→ Action = Send to a Worker → maildeck-mail**，并启用 Email Routing（会自动写 MX/SPF）。

## 在 MailDeck 里配置服务商

「服务商管理 → 新增服务商」选择 **Cloudflare 域名邮箱**：
- **BaseURL**：`https://maildeck-mail.<acct>.workers.dev`
- **API Key**：上面 `wrangler secret put API_TOKEN` 的值
- **catch-all 域名**：你的收信域，可多个用逗号分隔，如 `a.com,b.com`

保存后在「邮箱池 → 生成」或用户「获取邮箱」里选择该服务商即可生成 `前缀@域名`，
任意地址的来信都会被 catch-all 收进 Worker，MailDeck 里点开即可看到正文。

## Worker API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 无需鉴权：在线状态 + 邮件数 + D1 是否可用 |
| GET | `/inbox?alias=&since=&limit=` | 某地址最近邮件（MailDeck 列表/详情用） |
| GET | `/code?alias=&pattern=&since=` | 取最近一封能匹配验证码的邮件 |
| POST | `/test` | 灌测试信 `{to, code?}` |
| DELETE | `/message?id=` | 删除某封邮件（MailDeck 删除用） |

鉴权：`Authorization: Bearer <API_TOKEN>`（`/health` 除外）。
