# MailDeck Tauri 2 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MailDeck 桌面壳从 Electron 换成 Tauri 2 + Node sidecar，保留 React 前端与 Fastify 服务端。

**Architecture:** Rust shell 负责窗口、单实例、sidecar 生命周期与一次性凭据；前端以 `VITE_FORCE_HTTP_API=1` 构建到独立目录 `dist-tauri/`，通过 Tauri invoke 取到 `serverUrl`/`apiToken` 后复用 `createHttpMailDeckApi`；sidecar 是 esbuild 打包的单文件 Fastify 服务，绑定 127.0.0.1 随机端口。

**Tech Stack:** Tauri 2 (2.12.4)、Rust 1.77.2+、WebView2、Node 24 (`node:sqlite`)、esbuild 0.25、Vite 6、React 19、Fastify 5、Vitest 4。

**Spec:** [docs/superpowers/specs/2026-11-09-tauri2-design.md](../specs/2026-11-09-tauri2-design.md)

## Global Constraints

- Windows 10 1809+ / x86_64 / WebView2 Runtime；Rust 1.77.2+；Node >= 22.12.0。
- 不改 `electron/` 主进程、`server/` 业务逻辑、`src/` 组件与现有测试断言。
- `package.json` 里 Electron 的 `dev` / `dist:win` / `verify` 脚本保持不变。
- Tauri 构建产物统一落在 `src-tauri/target/`，`src-tauri/resources/` 由脚本生成且被 git 忽略。
- 不执行 `git commit` / `git push`。
- sidecar 只绑 `127.0.0.1`，API token 每次启动随机生成。

---

### Task 1: Rust shell 工程骨架

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/.gitignore`
- Create: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/secrets.rs`, `src-tauri/src/sidecar.rs`

**Interfaces:**
- Produces: `DesktopConfig { server_url, api_token, version }`（serde `rename_all = "camelCase"`）、`DesktopState { config, sidecar }`、`sidecar::start(app, data_dir, master_key) -> (port, token, SidecarProcess)`、Tauri commands `desktop_config` / `open_external` / `app_version`。
- Consumes: `src-tauri/resources/node.exe`、`src-tauri/resources/maildeck-server.mjs`（Task 3 生成）；`GET /api/health`（`server/src/index.ts:177`）。

- [ ] **Step 1:** 写 `Cargo.toml`：`tauri = "2"`, `tauri-plugin-shell = "2"`, `tauri-plugin-single-instance = "2"`, `serde`, `serde_json`, `rand = "0.8"`, `base64 = "0.22"`；`tauri-build = "2"`；lib `crate-type = ["staticlib","cdylib","rlib"]`。
- [ ] **Step 2:** 写 `tauri.conf.json`：`identifier = "com.maildeck.desktop"`，`build.frontendDist = "../dist-tauri"`，`build.devUrl = "http://127.0.0.1:5173"`，窗口 label `main`，`app.security.capabilities = ["default"]`，`bundle.targets = ["nsis","msi"]`，`bundle.resources` 映射 `resources/node.exe` 与 `resources/maildeck-server.mjs`。
- [ ] **Step 3:** 写 `lib.rs`：`Builder::default().plugin(shell).plugin(single_instance).invoke_handler(...).setup(...)`；setup 里 `app_data_dir()` → `load_or_create_master_key` → `sidecar::start` → `app.manage(DesktopState)`；`App::run` 的 `RunEvent::Exit` 里 `SidecarProcess::stop()`。
- [ ] **Step 4:** 写 `sidecar.rs`：`TcpListener::bind("127.0.0.1:0")` 选端口，`Command` 启动 sidecar（Windows `CREATE_NO_WINDOW`），注入 `MAILDECK_HOST/PORT/API_TOKEN/DATA_DIR/MASTER_KEY/CORS_ORIGINS`，手写 HTTP GET `/api/health` 轮询最多 20 s，失败即 kill。
- [ ] **Step 5:** 写 `secrets.rs`：`rand::thread_rng().fill_bytes(32)` + `URL_SAFE_NO_PAD` 生成 token；`master.key` 落盘复用。
- [ ] **Step 6:** 写 `commands.rs`：`desktop_config` 返回 state.config；`open_external` 校验 scheme 后 `app.shell().open(url, None)`；`app_version` 返回 `CARGO_PKG_VERSION`。
- [ ] **Step 7:** 验证：`npx tauri info`（配置可解析、WebView2 已安装）；有 Rust 工具链时 `cargo check --manifest-path src-tauri/Cargo.toml`。

### Task 2: 前端 Tauri 引导与测试

**Files:**
- Create: `src/tauri-env.d.ts`, `src/tauri-bootstrap.ts`, `tests/tauri-bootstrap.test.ts`
- Modify: `src/main.tsx`, `src/http-maildeck-api.ts:160-173`

**Interfaces:**
- Consumes: Tauri command `desktop_config` → `{ serverUrl, apiToken, version }`；`open_external` → `boolean`；`saveConnectionConfig()` from `src/connection-config.ts:71`。
- Produces: `isTauri(): boolean`、`bootstrapTauri(maxAttempts = 20): Promise<boolean>`、`window.__MAILDECK_TAURI__.openExternal`。

- [ ] **Step 1:** 写失败测试 `tests/tauri-bootstrap.test.ts`：非 Tauri 环境返回 false 且不写配置；Tauri 环境注入 config 并规范化 URL；`openExternal` 转发到 `invoke("open_external", { url })`；invoke 前两次失败第三次成功时重试生效；`maxAttempts = 2` 时全失败抛错。
- [ ] **Step 2:** 运行 `npx vitest run tests/tauri-bootstrap.test.ts`，确认 FAIL（模块不存在）。
- [ ] **Step 3:** 实现 `src/tauri-env.d.ts`（`Window.__TAURI_INTERNALS__`、`Window.__MAILDECK_TAURI__`）与 `src/tauri-bootstrap.ts`（20 次 × 200 ms 重试、`saveConnectionConfig`、挂 openExternal hook）。
- [ ] **Step 4:** 修改 `src/main.tsx`：`Bootstrap` 增加 `tauriPending` / `tauriError` 状态，Tauri 环境先显示「正在启动本地服务…」，bootstrap 完成后再进入既有 `ConnectionSetup` / `App` 分支。
- [ ] **Step 5:** 修改 `src/http-maildeck-api.ts` 的 `app.openExternal`：存在 `window.__MAILDECK_TAURI__` 时优先用 Tauri 命令，否则保留 `window.open` 原逻辑。
- [ ] **Step 6:** 运行 `npx vitest run tests/tauri-bootstrap.test.ts` 与 `npm run typecheck:renderer`，确认 PASS。

### Task 3: sidecar 打包与 npm 脚本

**Files:**
- Create: `scripts/bundle-tauri-server.mjs`, `scripts/prepare-tauri-sidecar.ps1`
- Modify: `package.json` scripts, `.gitignore`, `README.md`

**Interfaces:**
- Consumes: `npm run build:server`（`tsc -p server/tsconfig.build.json` → `dist-server/server/src/index.js`），`node_modules/esbuild`，系统 `node.exe`。
- Produces: `src-tauri/resources/maildeck-server.mjs`、`src-tauri/resources/node.exe`；npm scripts `build:tauri:web` / `prepare:tauri` / `dev:tauri` / `dist:tauri`。

- [ ] **Step 1:** 写 `bundle-tauri-server.mjs`：`esbuild.build({ entryPoints: ["dist-server/server/src/index.js"], bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], outfile: "src-tauri/resources/maildeck-server.mjs", banner: { js: createRequire shim } })`。
- [ ] **Step 2:** 写 `prepare-tauri-sidecar.ps1`：校验 `dist-server/server/src/index.js`、复制 `node.exe` 到 resources、调用上一步打包、输出体积报告。
- [ ] **Step 3:** `package.json` 增加 scripts，保持 Electron 脚本原样；`.gitignore` 增加 `src-tauri/target/`、`src-tauri/resources/`、`src-tauri/gen/`；README 增加「Tauri 2 桌面壳」章节。
- [ ] **Step 4:** 运行 `npm run build:tauri:web` 与 `npm run prepare:tauri`，确认 `dist/index.html` 与两个 sidecar 文件存在。

### Task 4: 发布流水线与迁移文档

**Files:**
- Create: `.github/workflows/release-tauri.yml`, `docs/tauri-desktop.md`

- [ ] **Step 1:** 写 CI：windows-2022 + `dtolnay/rust-toolchain@stable` + Node 24 + `npm ci --ignore-scripts` + `npm run build:tauri:web` + `npm run prepare:tauri` + `npx tauri build --target x86_64-pc-windows-msvc`，上传 `src-tauri/target/release/bundle/`。
- [ ] **Step 2:** 写 `docs/tauri-desktop.md`：构建命令、目录说明、凭据迁移步骤、签名更新开启方式、Node sidecar → Go/Rust sidecar 的降体积路径、验收数值。
- [ ] **Step 3:** 检查 YAML 与 Markdown 中命令与 `package.json` scripts 完全一致。

### Task 5: 全量验证

- [ ] **Step 1:** `npm run typecheck:renderer` → exit 0。
- [ ] **Step 2:** `npm test` → 全量用例 0 失败（新增用例计入）。
- [ ] **Step 3:** `npm run build:tauri:web` → `dist/index.html` 生成且 `VITE_FORCE_HTTP_API=1` 注入。
- [ ] **Step 4:** `npx tauri info` → 配置解析成功、WebView2 报告存在；Rust 工具链缺失时如实记录，`cargo check` 留作装好 rustup 后的复验项。
- [ ] **Step 5:** `git status --short` 核对变更集只含计划内文件，未提交。
