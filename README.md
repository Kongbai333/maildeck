# MailDeck

MailDeck 是多用户邮箱网页工作台：一个 Node.js 服务提供 API 和网页静态资源，通过浏览器登录使用。账号凭据、邮箱池和邮件缓存保存在服务端。

## 功能

- **三类邮箱**：Outlook 账号导入与领取、域名邮箱别名生成、临时邮箱随机生成。仅 Outlook 支持账号导入；用户自助导入自己的 Outlook 账号不占领取配额。
- **管理员控制台**：收信概览、三类邮箱池、导入与生成、分配与回收、批量操作、标签、用户权限与配额、邮件服务商配置。
- **个人邮箱**：按类型和标签筛选，获取邮箱时可选 1～20 个，复制地址、查看收件箱、阅读邮件和释放邮箱。三类配额独立；释放不返还已用额度，管理员可重置用量。
- **在线播放**：按账号开通权限，浏览频道、保存关注、打开关注前刷新主播地址，以及多个独立直播窗口。
- **工作台界面**：浅色、深色和跟随系统主题；根字号为 105%，外层固定视口，内容、表格和邮箱列表在各自区域内滚动；窄屏使用折叠菜单与响应式布局。
- **账号体系**：账号密码登录、HttpOnly 会话 Cookie、服务端角色与资源归属校验。

## 快速开始

需要 Node.js **22.13.0 或更高版本**，推荐使用 **Node.js 24**，与 Docker 镜像保持一致。以下命令均在仓库根目录执行。

```bash
npm install
npm run dev
```

开发时同时启动 API（8787）和网页（5174）。浏览器打开 `http://127.0.0.1:5174`；网页开发服务器将 `/api` 请求转发到 `http://127.0.0.1:8787`。

首次启动自动创建管理员，初始密码打印在服务端日志中。也可在首次启动前设置 `MAILDECK_ADMIN_USERNAME` 和 `MAILDECK_ADMIN_PASSWORD`。

## 构建与运行

```bash
npm run build
npm start
```

构建生成 `webapp/dist` 和 `dist-server`。`npm start` 执行 `node dist-server/server/src/index.js`，由服务端同时提供 API 和网页；浏览器打开 `http://127.0.0.1:8787`。服务端只托管 `webapp/dist`，首次生产启动前先完成构建。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动网页和 API 开发服务，等价于 `npm run dev:cloud` |
| `npm run dev:webapp` | 单独启动网页开发服务，默认端口 5174 |
| `npm run dev:server` | 单独启动 API 开发服务，默认端口 8787 |
| `npm run build` | 构建网页和服务端，等价于 `npm run build:cloud` |
| `npm run build:webapp` | 单独构建网页 |
| `npm run build:server` | 单独编译服务端 |
| `npm start` | 运行已构建的服务端及网页 |
| `npm run start:cloud` | 保留的兼容命令：先构建，再启动服务端 |

部署前设置 `MAILDECK_MASTER_KEY`，并保存该密钥与服务端数据目录的备份。环境变量、认证及 API 见[服务端说明](server/README.md)，容器与反向代理部署见[Docker 部署说明](DOCKER.md)。

## 项目结构

```text
webapp/       React 19 + TypeScript + Vite 网页工程
server/       Fastify HTTP 服务、账号权限、邮箱池与页面托管
shared/       共用类型、契约和纯工具
server/mail/  Graph / IMAP、OAuth、邮件解析与传输辅助模块
scripts/      网页联调、服务端维护与直播诊断脚本
tests/        服务端、共享模块与网页相关验证
deploy/       Caddy / Nginx 部署配置
docs/         网页设计与领域说明
```

前端使用 React、lucide-react 和原生 CSS；邮件 HTML 由 DOMPurify 清洗。服务端使用 SQLite，邮件能力包括 Microsoft Graph、IMAP 及临时邮箱服务商适配。兼容 HTTP 管理接口继续保留，其鉴权与业务契约不因工程整理而改变。

## 开发约定

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

以上分别用于类型检查、静态检查、自动化测试和生产构建；也可通过 `npm run verify` 执行类型检查、lint 与测试。

本地联调可运行：

```bash
node scripts/mock-gptmail.mjs
```

该脚本在 8899 模拟 GPTMail 和 mail.tm，可用于网页服务商与收件箱联调。更多前端约定见[网页工程说明](webapp/README.md)，模块职责见[领域上下文](CONTEXT.md)，域名邮箱配置见[域名邮箱说明](docs/domain-mail.md)。

## 数据与备份

- 数据目录由 `MAILDECK_DATA_DIR` 指定，包含 SQLite 数据库及缓存；容器内默认使用 `/data`。
- `MAILDECK_MASTER_KEY` 用于加密服务端凭据和服务商密钥。恢复数据库时应使用原主密钥。
- 登录会话、角色、邮箱归属和配额由服务端校验。浏览器通过 HTTP API 操作，不直接访问数据库。
- 升级前备份数据目录和部署配置；截图或示例数据应去除真实邮箱、凭据与邮件内容。

## 许可证

[MIT](LICENSE) © 2026 予星河
