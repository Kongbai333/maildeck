# MailDeck Webapp

MailDeck 的浏览器界面，包括管理员控制台、个人邮箱与在线播放。工程使用 React 19、TypeScript 和 Vite，复用仓库根目录的依赖。

实际 HTTP 契约以[服务端说明](../server/README.md)与路由实现为准；[网页设计稿](../docs/web-admin-design.md)和[增量设计说明](../docs/web-admin-design-v2.md)保留设计背景。

## 开发与构建

需要 Node.js **22.13.0+**，推荐 **Node.js 24**。以下命令在仓库根目录执行：

```bash
npm install
npm run dev
```

`npm run dev` 等价于 `npm run dev:cloud`，同时启动 API（8787）和网页（5174）。浏览器打开 `http://127.0.0.1:5174`，管理员初始密码见服务端首次启动日志。

也可分别启动：

```bash
npm run dev:server
npm run dev:webapp
```

类型检查与构建：

```bash
npx tsc -p webapp/tsconfig.json --noEmit
npm run build:webapp
npm run build
npm start
```

`npm run build` 与 `npm run build:cloud` 构建网页和服务端；`npm start` 运行已经构建的服务端。网页产物位于 `webapp/dist`，服务端只托管该目录并提供 SPA 页面回退。生产访问地址默认为 `http://127.0.0.1:8787`。

## 目录结构

```text
webapp/
├── index.html
├── vite.config.ts          # root=webapp，base=/，开发端口 5174，代理 /api
├── tsconfig.json           # strict、react-jsx、bundler 解析、noEmit
└── src/
    ├── main.tsx            # 挂载、主题初始化、全局样式
    ├── App.tsx             # hash 路由、会话引导、角色守卫
    ├── api.ts              # fetch 与响应信封、接口函数
    ├── types.ts            # 网页契约类型
    ├── session.tsx         # 会话上下文与 API 错误处理
    ├── router.ts           # location.hash 路由
    ├── sanitize.ts         # 邮件 HTML 清洗
    ├── use-host-follows.ts # 账号关注列表与关注操作状态
    ├── styles.css          # 通用组件基础布局
    ├── styles/            # 主题、工作台、登录/概览、视口与在线播放样式
    ├── components/        # 导航、弹窗、邮箱面板、关注列表、多直播窗口
    └── pages/
        ├── admin/         # 概览、邮箱池、用户与服务商
        └── user/          # 我的邮箱、获取/导入邮箱、在线播放
```

## 界面与交互约定

- 根字号为 **105%**；正文使用 `rem`。外层固定在视口内，页面内容、表格、邮箱列表和读信区域按布局承担内部滚动。
- 支持浅色、深色与跟随系统主题。导航按管理空间和个人空间分组；窄屏使用移动菜单，邮箱类型与标签筛选保留。
- 「获取邮箱」支持选择 **1～20 个**。仅 Outlook 支持账号导入；三类配额独立，用户自助导入 Outlook 不占领取配额，释放不返还已用额度。
- 在线播放按账号权限显示；支持关注主播、打开关注前刷新平台列表，以及多个独立直播窗口。关注记录由服务端按账号保存。
- 异步请求处理加载、失败和取消状态；切换账号、页面或筛选条件后，过期结果不应覆盖当前视图。

## API 与邮件内容

- 请求使用 `credentials: "same-origin"`，账号鉴权依赖 HttpOnly Cookie `md_session`；开发服务器将 `/api` 代理到 8787。
- 成功响应为 `{ ok: true, value }`；失败响应为 `{ ok: false, error: { code, message, retryable } }`。API 封装兼容没有 `value` 的成功写响应。
- 普通请求遇到 `401` 时，由会话错误处理回到登录页；登录接口的凭据错误作为表单错误展示。
- 邮件 HTML 统一通过 DOMPurify 清洗，移除可执行元素和内联事件，并处理外链属性。正文清洗入口见[邮件清洗模块](src/sanitize.ts)。
- 收件箱每 10 秒轮询，页面隐藏时暂停，恢复可见时刷新。
- 资源归属、功能权限和配额由服务端执行；界面的菜单和按钮状态只负责交互呈现。

本地假服务商可通过 `node scripts/mock-gptmail.mjs` 启动。开发文档和截图应使用去标识的样例数据；项目首页不引用旧业务截图。
