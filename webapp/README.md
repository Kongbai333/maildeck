# MailDeck Webapp

MailDeck 网页前端（管理员控制台 + 普通用户取邮箱），独立 Vite + React 19 + TypeScript 工程，
复用仓库根目录的 `node_modules`，不新增依赖。

接口契约以 [`../docs/web-admin-design.md`](../docs/web-admin-design.md) 为准，前端只消费，不定义。

## 开发

```bash
# 仓库根目录：一条命令起后端 + 前端
npm run dev:cloud

# 或者分开：
npm run dev:server     # API 8787
npm run dev:webapp     # 前端 5174，/api 代理到 127.0.0.1:8787
```

打开 http://127.0.0.1:5174 即可。管理员初始密码见后端启动日志。

## 类型检查与构建

```bash
# 仓库根目录
npx tsc -p webapp/tsconfig.json --noEmit
npm run build:webapp          # 等价于 vite build webapp
npm run build:cloud           # 前端 + 服务端一起构建
```

构建产物在 `webapp/dist`（`emptyOutDir: true`，每次构建前清空，不会残留旧 hash 文件）。
后端把 `webapp/dist` 作为静态目录，SPA 回退到 `index.html`。

## 目录结构

```
webapp/
├── index.html
├── vite.config.ts        # root=webapp, base=/, outDir=dist, port 5174, /api 代理
├── tsconfig.json         # strict + react-jsx + bundler 解析 + noEmit
└── src/
    ├── main.tsx          # 挂载 + ToastProvider
    ├── App.tsx           # hash 路由 + 会话引导 + 角色守卫
    ├── api.ts            # fetch 封装（信封解析 / 401 / ApiError）+ 全部接口函数
    ├── types.ts          # 契约类型
    ├── session.tsx       # 会话上下文 + 统一错误处理
    ├── router.ts         # location.hash 极简路由
    ├── sanitize.ts       # DOMPurify 清洗邮件 HTML
    ├── utils.ts          # 时间/大小格式化、复制兜底、状态文案
    ├── styles.css        # 设计系统与页面样式（自包含）
    ├── components/       # LoginPage / AppShell / Toast / Modal / ConfirmDialog
    │                     # EmptyState / Spinner / Badge / MessageReader
    │                     # MailboxInboxPanel / ChangePasswordModal
    └── pages/
        ├── admin/        # OverviewPage / MailboxesPage(+Generate/Import/Assign/消息抽屉)
        │                 # UsersPage / ProvidersPage
        └── user/         # MyMailboxPage
```

## 关键约定

- 请求一律 `credentials: "same-origin"`，鉴权靠 HttpOnly Cookie `md_session`。
- 成功信封 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message } }`。
  `api.ts` 对「只返回 `{ ok: true }` 的写接口」也做了兼容（无 `value` 时返回整个包体）。
- `401` 抛 `UnauthorizedError`，由 `useApiFailure` 清空本地会话并回登录页；
  登录接口的 401 是「用户名或密码错误」，按普通 `ApiError` 处理。
- 邮件正文 HTML 统一走 `sanitize.ts`：DOMPurify html profile + 禁用
  `script/style/iframe/object/embed/form` 与内联事件，并移除 `a[target]`、补 `rel="noreferrer noopener"`。
- 收件箱每 10 秒轮询，`document.visibilityState === "hidden"` 时暂停，回到前台立即刷新。
- 时间统一 `YYYY-MM-DD HH:mm`，空值显示 `—`；<= 900px 侧栏折叠为抽屉，阅读器改为覆盖式。
