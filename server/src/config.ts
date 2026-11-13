import path from "node:path";

function intFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const serverConfig = {
  host: process.env.MAILDECK_HOST?.trim() || "127.0.0.1",
  port: intFromEnv("MAILDECK_PORT", 8787),
  dataDir: path.resolve(process.env.MAILDECK_DATA_DIR?.trim() || path.join(process.cwd(), "data")),
  databaseFile: process.env.MAILDECK_DB_FILE?.trim() || "maildeck-server.db",
  masterKey: process.env.MAILDECK_MASTER_KEY?.trim() || "",
  apiToken: process.env.MAILDECK_API_TOKEN?.trim() || "",
  proxyUrl: process.env.MAILDECK_PROXY_URL?.trim() || "",
  /** 首次启动自动创建的管理员账号；密码留空则随机生成并在控制台打印一次。 */
  adminUsername: process.env.MAILDECK_ADMIN_USERNAME?.trim() || "admin",
  adminPassword: process.env.MAILDECK_ADMIN_PASSWORD?.trim() || "",
  sessionTtlDays: intFromEnv("MAILDECK_SESSION_TTL_DAYS", 7),
  /** 用户释放邮箱时是否顺手清空远端收件箱（后台执行，不阻塞接口）。 */
  releaseClearsInbox: process.env.MAILDECK_RELEASE_CLEAR_INBOX !== "0",
  /** 网页构建产物（相对仓库根目录）。 */
  webRoots: ["webapp/dist"],
  corsOrigins: (
    process.env.MAILDECK_CORS_ORIGINS ||
    "http://127.0.0.1:5174,http://localhost:5174"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
} as const;

export function databasePath() {
  return path.join(serverConfig.dataDir, serverConfig.databaseFile);
}
