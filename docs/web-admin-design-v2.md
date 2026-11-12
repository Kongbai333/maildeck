# 网页端增量（v2）：用户自助导入 · 布局整改 · 域名邮箱/临时邮件

本轮三件事：① 普通用户可以自己导入邮箱；② 页面布局按下面的规格整改；③ 新增两类服务商适配器
（临时邮箱 mail.tm、域名邮箱 IMAP catch-all），管理后台要能配置。

## 1. 新增接口（已冻结）

### 1.1 类型

```ts
type ProviderKind = "temp" | "domain"; // 临时邮箱 / 域名邮箱

interface ProviderTypeView {
  type: string;              // "gptmail" | "mailtm" | "imap"
  label: string;             // "GPTMail" | "mail.tm" | "IMAP 域名邮箱"
  kind: ProviderKind;
  defaultBaseUrl: string;
  requiresKey: boolean;      // 创建时是否必须填 API Key（imap 是密码）
  configFields: Array<"baseUrl" | "apiKey" | "keyMode" | "host" | "port" | "secure" | "user" | "domain">;
}

interface ProviderView {
  id: string; name: string; type: string; baseUrl: string;
  hasKey: boolean; enabled: boolean; mailboxCount: number;
  keyMode: "public" | "personal";
  typeLabel: string;
  kind: ProviderKind;
  meta: Record<string, string>; // imap: { host, port, secure, user, domain }
}

interface ProviderOption { // 用户侧，不含任何密钥
  id: string; name: string; type: string; typeLabel: string; kind: ProviderKind;
  supportsImport: boolean;   // 可粘贴已有地址
  supportsGenerate: boolean; // 可由服务端生成新地址
  domain: string;            // 域名邮箱的 catch-all 域名，可为空
}
```

### 1.2 用户侧

| 方法 | 路径 | 请求 | 成功返回 |
| --- | --- | --- | --- |
| GET | `/api/me/providers` | 无 | `ProviderOption[]` |
| POST | `/api/me/mailboxes/import` | `{ providerId, text }` | `{ imported, skipped, quotaSkipped, errors: string[] }` |
| POST | `/api/me/mailboxes/generate` | `{ providerId, prefix?, count? }` | `{ mailboxes: MailboxView[], errors: string[] }` |

- `text` 每行 `地址` 或 `地址,备注`，`#` 开头忽略；单次最多 200 行。
- 导入与生成都受配额限制：能放几个就放几个，放不下的计入 `quotaSkipped`（生成时多余的直接不生成）。
- 地址必须属于该服务商可读范围：`imap` 必须是该服务商 `meta.domain` 的地址，`mailtm` 不支持导入（只支持生成），
  `gptmail` 不限域名。校验失败的行进 `errors`。

### 1.3 管理侧

| 方法 | 路径 | 请求 | 成功返回 |
| --- | --- | --- | --- |
| GET | `/api/admin/provider-types` | 无 | `ProviderTypeView[]` |
| POST | `/api/admin/providers` | `{ name?, type, baseUrl?, apiKey?, keyMode?, meta? }` | `ProviderView[]` |
| GET | `/api/admin/providers` | 无 | `ProviderView[]` |
| GET | `/api/admin/providers/:id/domains` | 无 | `DomainEntry[]`（imap 返回 `[{ domain: meta.domain, wildcard: true }]`） |

`POST /api/admin/providers` 的 `meta`（仅 `imap` 用）：`{ host, port, secure: "1"|"0", user, domain }`，`apiKey` 为该账号密码。

## 2. 前端整改要求（`webapp/**` 全部归你）

### 2.0 尺寸基调：PC 优先

产品主要给 PC 浏览器用，**按桌面尺寸设计，不要为了移动端把界面缩小**。

- 内容区 `max-width: 1600px`，左右 padding 32px；≥1600 视口基本占满。
- 正文 15px、表格 14.5-15px、页面标题 22-24px、统计数字 30-34px、次要文字 13px 起。
- 控件：按钮高 38-40px、输入框 40px、表格行高 56-60px、卡片内边距 24px、卡片间距 20px。
- 登录页表单卡 440-480px，品牌区标题 40px 级别。
- 响应式只保证「不崩、不溢出」：≤1024 侧栏收起，≤768 表格横向滚动；不压缩字号、不缩小按钮。
- 验收截图：1920×1080 与 1440×900 各一组（管理员邮箱池、我的邮箱），1280 检查不溢出即可。

### 2.1 布局

统一规范：内容区 1600px、水平内边距 32px；卡片圆角 14px、内边距 24px、卡片间距 20px；
表格行高 56-60px、表头吸顶；页面标题区与内容间距 20px。

必须修掉的具体问题：

1. **邮箱池表格**：操作列 5-6 个图标挤成一排 → 只保留「分配」「邮件」两个文字按钮，其余收进「⋯」下拉
   （回收 / 停用·启用 / 删除，删除为危险色）；列宽：地址 28%、服务商 16%、状态 9%、归属 10%、备注 15%、
   创建时间 12%、操作 10%；表格容器 `overflow-x:auto`。
2. **「我的邮箱」顶部**：现在是一张邮箱卡 + 一张空的「再领一个」虚线卡并排，空卡很难看 →
   改成一条工具条：左侧「我的邮箱 · 配额 1/1」，右侧按钮组「导入邮箱」「生成新地址」「获取邮箱（领取）」；
   邮箱列表用卡片网格（`repeat(auto-fill, minmax(300px, 1fr))`），选中卡片高亮。
3. **登录页**：左品牌区 44% / 右表单区 56%，表单卡宽 460px 且垂直居中；≤900px 时品牌区折叠为顶部条。
4. **概览**：4 张统计卡在 ≥1200px 一行四列、768-1199px 两列、<768px 一列；最近邮箱表只留 5 列（地址/服务商/状态/归属/时间）。
5. **用户管理**：操作列同样收成「编辑」「更多（重置密码 / 启停 / 查看邮箱 / 删除）」。
6. 所有下拉菜单：点击外部关闭、Esc 关闭、`aria-expanded`、键盘可达；z-index 高于表格但低于 Modal。

### 2.2 用户自助导入 / 生成

- 工具条「导入邮箱」→ 弹窗：服务商下拉（`/api/me/providers`，带 `临时邮箱`/`域名邮箱` 徽章）、
  文本域（占位 `{{EMAIL_a1b2c3}}`、`{{EMAIL_d4e5f6}},备用`）、说明「最多 200 行，受配额限制」；
  提交后展示 `imported / skipped / quotaSkipped / errors`，成功后刷新列表并 toast。
- 工具条「生成新地址」→ 弹窗：服务商下拉（只列 `supportsGenerate`）、前缀（可空）、数量 1-5；
  提交后 toast「已生成 N 个邮箱」并刷新。
- 配额已满时两个按钮都禁用并给 `title` 说明；导入弹窗里若剩余配额为 0 直接提示先释放。

### 2.3 服务商表单按类型分支

- `gptmail`：BaseURL、API Key、Key 模式（公共/个人）。
- `mailtm`：BaseURL（默认 `https://api.mail.tm`），无需 Key；提示「自动注册地址并保存口令」。
- `imap`：主机、端口（默认 993）、SSL 开关、用户名、密码、域名（catch-all），并提示
  「所有 `*@域名` 的邮件都从该 IMAP 账号读取」。
- 列表：类型列显示 `typeLabel` + 徽章（临时/域名）；`imap` 额外显示 `meta.user@host` 与 `meta.domain`；
  行内操作保留「拉取域名」「删除」。

## 3. 交付与自检

- 只改 `webapp/**`；`api.ts` / `types.ts` 按上面契约补齐；不要动 `server/**`、`tests/**`、`docs/**`。
- `npx tsc -p webapp/tsconfig.json --noEmit` 与 `npm run build:webapp` 必须 0 error。
- 改完自查五个宽度（1440/1280/1024/768/500）无溢出，并各截一张图放到 `webapp/.shots/`（不要提交）。

## 4. v2.1 增量：三类配额 + 池子只放 Outlook

产品口径：**邮箱池 = Outlook（微软）账号池**，管理员导入、用户领取；域名邮箱（IMAP catch-all）与临时邮箱
（GPTMail / mail.tm）由用户自助导入或生成，不进池子。三类各自独立配额。

### 4.1 类型

```ts
type ProviderKind = "temp" | "domain" | "outlook";
interface QuotaBuckets { outlook: number; domain: number; temp: number }

SessionUser   { mailboxQuota: number; quotas: QuotaBuckets }              // mailboxQuota 是 outlook 的旧别名
AdminUserView { mailboxCount: number; mailboxCounts: QuotaBuckets }
MailboxView   { kind: "outlook" | "domain" | "temp" }                    // Outlook 行 providerId="", providerName="Outlook"
```

### 4.2 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/mailboxes?kind=` | 默认 `outlook`（池子）；支持 `domain` / `temp` / `all` |
| POST | `/api/admin/outlook/import` | `{ text }`，格式沿用桌面端 `email----password----<clientId>----<refreshToken>[----备注]`，返回 `{ imported, skipped, errors }` |
| POST/PATCH | `/api/admin/users` | 接受 `quotas: { outlook, domain, temp }` |
| POST | `/api/me/mailboxes/claim` | 只领 Outlook 账号 |
| POST | `/api/me/mailboxes/import` | `{ text }`，**只导入 Outlook 账号**（同一套四段格式），按 outlook 桶计数 |
| POST | `/api/me/mailboxes/generate` | 只走域名/临时服务商（接口生成/随机），按对应桶计数 |

**导入口径（v2.2）**：只有 Outlook 能导入；域名邮箱与临时邮箱一律由接口生成或随机分配，不接受「导入已有地址」。
`supportsImport` 对 `gptmail` / `mailtm` / `imap` 全部为 `false`。

Outlook 账号的收件箱可读（列表 + 详情），但**删除单封、清空收件箱返回 409**（暂不支持），
`PATCH /api/admin/mailboxes/:id`（改状态）对 Outlook 行也返回 409 —— 这类行只保留「分配 / 回收 / 邮件」。

### 4.3 页面调整

- 邮箱池页拆成三个池子页签：**Outlook 账号池 / 域名邮箱池 / 临时邮箱池**（`GET /api/admin/mailboxes?kind=`）。
  Outlook 池：导入 Outlook 账号、分配、回收、删除；域名/临时池：生成邮箱、分配、停用·启用、删除。
- 用户「我的邮箱」工具条展示三个配额 chip（Outlook / 域名 / 临时），「获取邮箱」只影响 Outlook 桶，
  「生成新地址」按所选服务商落到域名或临时桶。
- 用户管理：三档配额输入 + 三列已用计数。

### 4.4 v2.2 修订（按用户最新口径）

1. **Outlook 账号池允许删除**：`DELETE /api/admin/mailboxes/:id` 对 Outlook 账号同样生效（直接删账号记录）。
2. **池子分三类**：不再只有 Outlook 一个池；域名邮箱与临时邮箱也各有池子视图（管理员可生成 / 分配 / 停用 / 删除）。
3. **用户自助导入 Outlook 不占配额**：`POST /api/me/mailboxes/import` 不检查也不扣减 outlook 配额，
   `quotaSkipped` 恒为 0；账号记录 `assigned_via='import'`，配额统计只算 `pool` / `admin` 来源。
   `MailboxView.quotaExempt` 为 `true` 时前端显示「不占配额」徽章。

### 4.5 v2.3 增量（本轮）

1. **新服务商 `yyds`（YYDS Mail / vip.215.im）**：临时邮箱，基础地址 `https://maliapi.215.im`，`X-API-Key`；
   **支持多把 Key**（表单每行一把），服务端按顺序轮换，401/403/429 自动换下一把；额外 Key 用主密钥加密存
   `meta.apiKeysEnc`，`ProviderView.keyCount` 返回总数。
2. **邮件缓存**：`mailbox_list_cache` / `mailbox_message_cache` / `mailbox_detail_cache`，读到即写；
   上游失败时自动回退最近一次成功结果，前端无需改动。删除单封/清空时同步清缓存。
3. **邮箱池批量操作**：`POST /api/admin/mailboxes/bulk { action, ids, userId? }`，
   action ∈ delete / disable / enable / assign / unassign，支持 Outlook 与域名/临时邮箱。
4. **统一「获取邮箱」**：`POST /api/me/mailboxes/acquire { kind, providerId? }`
   —— outlook 从账号池领取；domain / temp 由对应服务商生成一个地址并挂到当前用户名下（受对应配额限制）。
5. **我的邮箱左右布局**：左侧邮箱列表（320px 独立滚动），右侧当前邮箱的收件箱 + 正文；≤1100px 折叠为顶部下拉。
### 4.6 v2.4 增量（本轮）

1. **导入 Outlook 可选分配用户**：`POST /api/admin/outlook/import { text, userId? }` → 额外返回 `assigned`；
   不传 `userId` 则留在池子里（默认不分配）。
2. **统计页** `GET /api/admin/stats`：邮箱规模、收信总量/今日/近 7 天、按类型分布、近 7 天趋势（`daily`）、
   Top10 收信邮箱、今日领取数。前端 `#/admin/stats` 纯 CSS 柱状图，30 秒轮询。
3. **额度语义**：`users.used_outlook/used_domain/used_temp` 只增不减，释放/删除不返还；
   `SessionUser/AdminUserView.quotaUsage` 暴露已用量，管理员 `PATCH /api/admin/users/:id { resetUsage: true }` 重置。
4. **邮箱标签**：`domain_mailboxes.tags_json` / `accounts.tags_json`（≤12 个，单个 ≤24 字）；
   `PATCH /api/me/mailboxes/:id/tags`、`PATCH /api/admin/mailboxes/:id/tags`。
5. **主题与交互**：主色渐变、hover/focus 反馈、骨架屏、空态、侧栏指示条、顶部毛玻璃；
   浅色/深色/跟随系统切换（`data-theme`，localStorage，首帧应用防闪）。
   选中 `translateZ(40px)`），≤1100px 自动回退列表版；两版共用数据与选中逻辑。
### 4.7 v2.5 增量（本轮）

1. **新增服务商类型收敛**：新增弹窗只提供 `gptmail`（临时）与 `imap`（域名）两项；`mailtm` / `yyds` 适配器保留，
   仅用于兼容已存在的服务商记录。
2. **弹窗圆角**：`.modal` 统一 `overflow:hidden`，footer 补底部圆角；抽屉顶部圆角同理。
3. **批量操作条**：改为视口底部居中悬浮胶囊（`position: fixed`），不再挤压表格（实测表格 top 不变）。
4. **概览与统计合并**：删除「统计」菜单与 `#/admin/stats` 路由（访问重定向到概览）；
   概览页 = 数字卡（今日/近 7 天/累计收信/今日领取）+ 三类规模 + 7 天趋势 + Top10 + 最近邮箱。
   绿植、落地灯、地毯，一个小人（胶囊体+球头，待机浮动动画）与 **3 个邮筒**（Outlook / 临时 / 域名，
   带数量 Sprite）。`OrbitControls` 限位旋转缩放，`Raycaster` 点邮筒 → 右侧面板列出该类型邮箱 →
   点邮箱看邮件列表 → 点邮件看正文。无 WebGL 时降级提示 + 返回按钮；卸载时释放 geometry/texture/renderer。
### 4.8 v2.6 增量（本轮）

1. **新增服务商只保留 2 类**：`gptmail`（临时）与 `imap`（域名）；mailtm / yyds 适配器保留兼容。
2. **弹窗圆角**：`.modal { overflow: hidden }` + footer 底部圆角，抽屉顶部圆角。
3. **批量条悬浮**：`position: fixed; bottom:24px` 深色胶囊，不挤压表格；深底上按钮改用浅字深底样式，
   选中行 `rgba(99,102,241,.14)` + 左侧 3px 主色条，一眼可辨。
4. **概览 = 统计**：删除「统计」菜单与路由（旧链接重定向），概览合并趋势图/Top10/收信量。
   （生成素材，透明抠图）作 `THREE.Sprite`，脚下加径向渐变软阴影，头顶 CanvasTexture 数量牌；
   `OrbitControls` 小范围环视（±0.12rad）避免穿帮，`Raycaster` 点邮筒 → 该类型邮箱 → 邮件 → 正文。

### 4.9 v2.7 修订

移除「3D 邮箱」全部内容：路由 #/3d-mailboxes、左侧菜单项、Three.js 依赖、webapp/src/assets/3d/、webapp/public/office-ref/、eference/ 及对应样式与截图，均已删除；访问旧链接会回落到概览。

