# MailDeck Tauri 2 桌面壳

对齐 [DEEIX Chat 桌面端](https://deeix.com/docs/deeix-chat/desktop-app) 的架构：Rust shell 负责窗口与 sidecar 生命周期，WebView2 加载同一套静态前端，本地服务端作为 sidecar 绑在 `127.0.0.1` 随机端口。Electron 版的所有脚本、`electron/` 主进程、`server/` 业务逻辑、`src/` 组件与测试保持原样，Tauri 是并行构建目标。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src-tauri/` | Tauri 2 Rust 工程（`tauri.conf.json`、`capabilities/`、Rust 源码） |
| `src-tauri/src/lib.rs` | 窗口、单实例锁、setup、退出清理 |
| `src-tauri/src/sidecar.rs` | 选端口、启动 `node.exe maildeck-server.mjs`、健康检查 `/api/health` |
| `src-tauri/src/secrets.rs` | 一次性 API token、持久化的 `MAILDECK_MASTER_KEY` |
| `src-tauri/src/commands.rs` | `desktop_config` / `open_external` / `app_version` |
| `src/tauri-bootstrap.ts` | 前端启动引导：invoke 取配置 → `saveConnectionConfig` → 复用 HTTP API |
| `scripts/bundle-tauri-server.mjs` | esbuild 把 `dist-server` + 依赖打成单文件 ESM |
| `scripts/prepare-tauri-sidecar.ps1` | 复制 `node.exe`、生成 `maildeck-server.mjs` |
| `docs/tauri-desktop.md` | 本文档 |

`src-tauri/resources/`（`node.exe` 与 `maildeck-server.mjs`）和 `src-tauri/target/` 由脚本生成，已在 `.gitignore` 中。

## 前置

```powershell
# Rust（本机当前缺 rustup，装完重开终端）
winget install Rustlang.Rustup
rustup default stable
rustc --version   # 需 >= 1.77.2

# Node >= 22.12（sidecar 用 node:sqlite）
node -v

# WebView2 Runtime：Win10 1809+ / Win11 通常已内置
# 检查目录 C:\Program Files (x86)\Microsoft\EdgeWebView\Application
npm ci
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev:tauri` | 准备 sidecar → Vite dev server (5173) + `tauri dev` |
| `npm run build:tauri:web` | `VITE_FORCE_HTTP_API=1 vite build --outDir dist-tauri --emptyOutDir` → `dist-tauri/` |
| `npm run build:tauri:server` | `tsc -p server/tsconfig.build.json` → `dist-server/` |
| `npm run prepare:tauri` | 生成 `src-tauri/resources/{node.exe,maildeck-server.mjs}` |
| `npm run dist:tauri` | 上面三步 + `tauri build` → NSIS/MSI |
| `npx tauri info` | 检查配置、Rust、WebView2 状态 |

`dist:tauri` 的产物在 `src-tauri/target/release/bundle/nsis/` 与 `.../msi/`。CI 见 `.github/workflows/release-tauri.yml`。

## 启动数据流

1. Rust `setup`：`app_data_dir()` → 读/生成 `master.key`（32 字节 base64） → `TcpListener::bind("127.0.0.1:0")` 取空闲端口 → 生成随机 `MAILDECK_API_TOKEN`。
2. `Command` 启动 `node.exe maildeck-server.mjs`，注入 `MAILDECK_HOST/PORT/API_TOKEN/DATA_DIR/MASTER_KEY/CORS_ORIGINS`，Windows 加 `CREATE_NO_WINDOW`，CORS 放行 `http://tauri.localhost`。
3. 手写 HTTP GET `/api/health` 轮询最多 20 秒；失败即 kill 子进程并让启动失败可见。
4. 前端 `bootstrapTauri()` 调 `desktop_config` 拿 `{ serverUrl, apiToken, version }`，写入连接配置（20 次 × 200 ms 重试），期间首屏显示「正在启动本地服务…」。
5. `getDesktopApi()` 在 `VITE_FORCE_HTTP_API=1` 下返回 `createHttpMailDeckApi(config)`，`src/` 组件与 583 个用例零改动。
6. `openExternal` 走 `open_external` 命令（只允许 `http/https/mailto`），退出时 `RunEvent::Exit` kill sidecar；单实例锁聚焦已有窗口。

## 数据与安全

- sidecar 只绑 `127.0.0.1`，随机端口，局域网不可达。
- `/api` 除 `/api/health` 外全部要求 `Authorization: Bearer <token>`（`server/src/index.ts` 的 onRequest hook 已实现）；token 每次启动随机生成，不落盘、不写进前端源码。
- `master.key` 位于 `%APPDATA%\com.maildeck.desktop\master.key`（Tauri `app_data_dir()`），首次启动生成，之后复用，保证 sidecar 用 AES-256-GCM 加密的 refresh token 能解密。**备份/换机要连整个目录一起拷**。
- 数据目录：`%APPDATA%\com.maildeck.desktop\server-data\maildeck-server.db`（SQLite WAL）。
- WebView2 没有 Node 集成，渲染层拿不到 `window.maildeck`，CSP 沿用 `index.html` 并加上 Tauri 需要的 `asset:` / `ipc:` 来源。

### 从 Electron 版迁移账号

两版凭据加密体系不同：Electron 用 `safeStorage`（Windows DPAPI），sidecar 用 `MAILDECK_MASTER_KEY`（AES-256-GCM）。迁移步骤：

1. 在 Electron 版「设置 → 账号」导出账号清单（或直接用旧版数据库 `maildeck.db`）。
2. 在 Tauri 版导入弹窗粘贴 `email----client_id----refresh_token`，或重新走设备代码登录。
3. 旧库的邮件缓存在 Tauri 版首次刷新后重建，无需手工搬 `mail-cache`。
4. 后续接 Windows DPAPI / Credential Manager 存 `master.key`，可与 Electron 版共用同一保护边界。

## 签名应用内更新（需要 CI 密钥后开启）

DEEIX Chat 用 `tauri-plugin-updater` + Ed25519 公钥校验 `latest.json`。本项目密钥到位后按下面三步启用：

```powershell
# 1) 生成密钥对，私钥只放 CI secret TAURI_SIGNING_PRIVATE_KEY
npx tauri signer generate -w .tauri/maildeck.key
```

```toml
# 2) src-tauri/Cargo.toml
tauri-plugin-updater = "2"
```

```jsonc
// 3) src-tauri/tauri.conf.json → plugins
"updater": {
  "pubkey": "<公钥>",
  "endpoints": ["https://github.com/xinghe-labs/maildeck/releases/latest/download/latest.json"]
}
```

Rust 侧在 `lib.rs` 加 `.plugin(tauri_plugin_updater::Builder::new().build())`，前端 `update.*` 接口再接到 `check()` / `downloadAndInstall()`；现有 `http-maildeck-api.ts` 里 `update` 段的 idle/unsupported 桩保持可用。

## 体积与后续优化

当前 sidecar 是 Node 运行时（`node.exe` 约 85.8 MB 未压缩，NSIS 压缩后约 25–30 MB）+ 单文件 server bundle（约 1–2 MB），加上 Tauri/WebView2 壳，安装包目标 ≤ 40 MB，冷启动首帧目标 ≤ 0.5 s。

进一步降到 DEEIX Chat 桌面端量级（23 MB）或 Winc 量级（4.6 MB）的路径：

1. 把 `server/` 用 Go 或 Rust 重写成静态二进制 sidecar（`node:sqlite` → `rusqlite`/`modernc.org/sqlite`），去掉 `node.exe`；这一步同时把冷启动里的 Node 初始化省掉。
2. 或者把 Fastify 服务端用 Bun `build --compile` 打成单文件（约 50 MB，收益有限）。
3. 全 Rust 命令层（无 sidecar）：`#[tauri::command]` 直接实现 Graph/IMAP/SQLite，包体 ~8–12 MB，代价是 40 个主进程 TS 文件重写，见 `docs/superpowers/specs/2026-11-09-tauri2-design.md`。

## 本机启动实测（2026-11-09）

- Rust 工具链实际已装：`%USERPROFILE%\.cargo\bin\cargo.exe`（1.95.0 / rustc 1.95.0 / stable-x86_64-pc-windows-msvc）。`tauri info` 报 rustc/Cargo 缺失只是 PATH 未包含该目录：
  ```powershell
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
  cargo check --manifest-path src-tauri/Cargo.toml   # exit 0
  ```
- `cargo check` 过程中修掉两处 Rust 编译问题：`RunEvent::Exit` 里 `State` 与 `MutexGuard` 的生命周期冲突（改为先 `Arc::clone` 再在内部块里取 guard），以及 `shell::open` 弃用警告（局部 allow，后续迁 `tauri-plugin-opener`）。
- 本机只有 Windows SDK 与 MinGW-w64（`C:\mingw64`），缺 MSVC `cl.exe`/`link.exe`。GNU 绕行构建已跑通到产出 exe，过程中踩了四个坑并记录在配置里：中文路径让 `dlltool` 失败（`CARGO_TARGET_DIR` 必须纯 ASCII）、`cdylib` 触发 MinGW ld 的 `export ordinal too large`（crate-type 收窄为 `staticlib` + `rlib`）、`tauri-winres` 的 `resource.lib` 是 MSVC COFF（[build.rs](src-tauri/build.rs) 在 GNU 目标跳过资源嵌入）、以及必须放对 x64 版 `WebView2Loader.dll`。
- GNU debug 产物 `maildeck-desktop.exe`（207 MB）在本机启动即退出（0xC0000139 `STATUS_ENTRYPOINT_NOT_FOUND`）：Tauri 官方 Windows 目标要求 MSVC 工具链，GNU 仅用于验证源码与链接可行性。装好 VS Build Tools 后走 `x86_64-pc-windows-msvc`，`npm run dev:tauri` / `npm run dist:tauri` 即正式可用。
- 壳编译出来之前的等价运行入口 [scripts/serve-tauri-preview.mjs](scripts/serve-tauri-preview.mjs)：静态服务 `dist-tauri/` 并注入与 `desktop_config` 同形状的连接配置，配合 sidecar 与 `msedge --app=...` 起独立窗口。已实测四栏界面渲染、`/api/health` 200、Bearer 鉴权、未授权 401、SQLite WAL 建库全部正常。

## 已知限制

- 托盘、开机自启、`--hidden` 启动尚未从 Electron 版迁到 Tauri（设置页开关暂时只影响 Electron 版）。
- 自动更新当前是空实现；绿色版策略沿用 Electron 版说明。
- `master.key` 目前是文件形式，尚未走 DPAPI/Credential Manager。
- Rust 工具链在本机会话缺失，`cargo check` / `tauri build` 需装好 rustup 后复验；前端与 sidecar 侧的验证不受影响。
