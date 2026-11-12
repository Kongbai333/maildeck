# MailDeck Tauri 2 桌面壳设计（2026-11-09）

> 决策来源：把 Electron 壳替换为 DEEIX Chat 桌面端同款架构（[Desktop App 文档](https://deeix.com/docs/deeix-chat/desktop-app)），保留现有 Web UI 与服务端代码。

## 目标

用 Tauri 2（Rust shell + 系统 WebView2）承载 `dist-tauri/` 静态前端，以 sidecar 进程运行现有 Fastify 服务端；Windows 安装包显著小于 Electron 版（94 MB），冷启动进入亚秒级，前端 `src/` 与 `server/` 业务逻辑零改动。

## 架构

```
┌─────────────────────────────────────────────────┐
│ Tauri 2 shell (Rust, src-tauri/)                 │
│  · WebView2 窗口 main，加载 dist-tauri/index.html  │
│  · setup: 选空闲端口 → 生成一次性 API token      │
│    → 启动 node.exe maildeck-server.mjs sidecar   │
│    → 轮询 /api/health 直到就绪                   │
│  · commands: desktop_config / open_external      │
│    / app_version                                 │
│  · Exit 时 kill sidecar；单实例锁聚焦已有窗口     │
└───────────────┬─────────────────────────────────┘
                │ Tauri invoke + HTTP (127.0.0.1)
┌───────────────┴─────────────────────────────────┐
│ Web 前端 (src/, VITE_FORCE_HTTP_API=1)           │
│  · tauri-bootstrap.ts: invoke desktop_config     │
│    → saveConnectionConfig → 跳过连接设置页        │
│  · http-maildeck-api.ts: 全部 /api 调用原样复用   │
│  · app.openExternal 走 open_external 命令         │
└───────────────┬─────────────────────────────────┘
                │ Bearer <one-time token>
┌───────────────┴─────────────────────────────────┐
│ sidecar: node.exe + maildeck-server.mjs          │
│  · Fastify + node:sqlite，数据目录在 appdata      │
│  · MAILDECK_MASTER_KEY 由 shell 首次生成并持久化  │
│  · CORS 放行 http://tauri.localhost               │
└─────────────────────────────────────────────────┘
```

## 关键决策

1. **不改前端 API 契约**：`window.maildeck`（Electron preload）与 `createHttpMailDeckApi`（HTTP）已实现同一 `MailDeckApi`；Tauri 版强制 `VITE_FORCE_HTTP_API=1`，只注入连接配置，46 个 `src/` 文件与 583 个用例保持原样。
2. **sidecar 用 Node 而非 Go**：现有 `server/` 用 `node:sqlite`、Fastify、`mailparser`，用 esbuild 打成单个 `maildeck-server.mjs`，配一个 `node.exe` 即可运行；后续换 Go/Rust sidecar 可再降体积。
3. **一次性凭据**：shell 每次启动生成随机 `MAILDECK_API_TOKEN` 并通过 `desktop_config` 交给前端（对齐 DEEIX 的 one-time grant），token 不落盘、不出现在前端源码里；`/api/health` 不校验 token 便于健康检查。
4. **master key 持久化**：`app_data_dir/master.key`（32 字节 base64）首次启动生成，之后复用，保证 sidecar 里加密的 refresh token 可解密；后续可换成 Windows DPAPI / keychain。
5. **Electron 版保留**：`npm run dev` / `dist:win` 与既有发布链路不动，Tauri 作为并行目标（`dev:tauri` / `dist:tauri`），验证通过后再切换默认产物。

## 安全边界

- sidecar 绑定 `127.0.0.1`，随机端口，不接受局域网连接。
- `/api` 除 health 外全部要求 `Authorization: Bearer <token>`（`server/src/index.ts` 的 onRequest hook 已实现）。
- `open_external` 只允许 `http://` / `https://` / `mailto:`。
- CSP 沿用 `index.html`，另加 Tauri 需要的 `asset:` / `ipc:` 来源；`connect-src 'self' http: https:` 允许前端访问本地 sidecar。
- WebView2 无 Node 集成，`window.maildeck` 桥不再存在，渲染层拿不到任何凭据之外的进程能力。

## 验收口径

- `npm run typecheck:renderer`、`npm test`（全量）、`npm run build:tauri:web` 通过。
- `npx tauri info` 能解析 `src-tauri/tauri.conf.json` 且报告 WebView2 已安装。
- 装上 Rust 工具链后 `cargo check --manifest-path src-tauri/Cargo.toml` 通过，`npm run dist:tauri` 产出 NSIS/MSI。
- 冷启动到首帧目标 ≤ 0.5 s，安装包目标 ≤ 40 MB（Node sidecar 版；换 Go/Rust sidecar 后 ≤ 15 MB）。

## 已知后续项

- 签名更新（`tauri-plugin-updater` + Ed25519 公钥 / latest.json）需要 CI 密钥，配置入口已在文档中给出。
- 托盘、开机自启、隐藏启动沿用 Electron 版设置页语义，作为下一阶段。
- 旧 Electron `safeStorage` 加密的 refresh token 与 sidecar 的 `MAILDECK_MASTER_KEY` 体系不同，迁移时需在 Electron 版里导出一次明文再导入（文档给出步骤）。
