import { createHash, randomBytes, randomUUID } from "node:crypto";
import { serverConfig } from "./config.js";
import { getDb } from "./db.js";
import {
  conflict,
  forbidden,
  HttpError,
  invalid,
  notFound,
  rateLimited,
  unauthorized
} from "./http-utils.js";
import { hashPassword, verifyPassword } from "./password.js";

export type Role = "admin" | "user";
export type UserStatus = "active" | "disabled";

export const SESSION_COOKIE = "md_session";
const SESSION_TTL_MS = Math.max(1, serverConfig.sessionTtlDays) * 24 * 60 * 60 * 1_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{3,32}$/u;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60_000;

interface LoginAttempt {
  failures: number;
  lockedUntil: number;
}

const loginAttempts = new Map<string, LoginAttempt>();

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  mailbox_quota: number;
  quota_outlook: number | null;
  quota_domain: number | null;
  quota_temp: number | null;
  /** 已消耗额度（释放邮箱不回退）。 */
  used_outlook: number | null;
  used_domain: number | null;
  used_temp: number | null;
  can_online_play: number | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface QuotaBuckets {
  outlook: number;
  domain: number;
  temp: number;
}

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  mailboxQuota: number;
  quotas: QuotaBuckets;
  /** 已消耗额度；余量 = quotas - quotaUsage。 */
  quotaUsage: QuotaBuckets;
  /** 是否有「在线播放」权限（管理员可在用户管理里按账号开启）。 */
  canOnlinePlay: boolean;
}

export interface AdminUserView extends SessionUser {
  mailboxCount: number;
  mailboxCounts: QuotaBuckets;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Identity {
  userId: string | null;
  username: string;
  role: Role;
  /** 兼容旧桌面端的 Bearer Token，视为管理员。 */
  legacy: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "disabled" ? "disabled" : "active",
    mailboxQuota: row.mailbox_quota,
    quotas: getQuotas(row),
    quotaUsage: getQuotaUsage(row),
    canOnlinePlay: row.role === "admin" || Number(row.can_online_play ?? 0) === 1
  };
}

/** 三类配额；老库没有分桶时按 mailbox_quota 兜底。 */
export function getQuotas(row: UserRow): QuotaBuckets {
  const fallback = Number(row.mailbox_quota ?? 0);
  return {
    outlook: Number(row.quota_outlook ?? fallback),
    domain: Number(row.quota_domain ?? fallback),
    temp: Number(row.quota_temp ?? fallback)
  };
}

/** 已消耗额度（释放不回退；老库没有计数器时按当前归属数兜底）。 */
export function getQuotaUsage(row: UserRow): QuotaBuckets {
  return {
    outlook: Number(row.used_outlook ?? 0),
    domain: Number(row.used_domain ?? 0),
    temp: Number(row.used_temp ?? 0)
  };
}

/** 记一次额度消耗（领取/生成/管理员分配时调用）。 */
export function consumeQuota(userId: string, kind: keyof QuotaBuckets, amount = 1): void {
  const column =
    kind === "outlook" ? "used_outlook" : kind === "domain" ? "used_domain" : "used_temp";
  getDb()
    .prepare(`UPDATE users SET ${column} = COALESCE(${column}, 0) + ?, updated_at = ? WHERE id = ?`)
    .run(amount, nowIso(), userId);
}

/** 管理员重置已用量（0 = 全部额度重新可用）。 */
export function resetQuotaUsage(userId: string, kind?: keyof QuotaBuckets): void {
  const timestamp = nowIso();
  const columns =
    kind === undefined
      ? ["used_outlook", "used_domain", "used_temp"]
      : [kind === "outlook" ? "used_outlook" : kind === "domain" ? "used_domain" : "used_temp"];
  for (const column of columns) {
    getDb().prepare(`UPDATE users SET ${column} = 0, updated_at = ? WHERE id = ?`).run(timestamp, userId);
  }
}

function parseQuotaBuckets(value: unknown): QuotaBuckets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const read = (key: string): number => {
    const parsed = Number(source[key]);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 999) {
      throw invalid(`配额 ${key} 需为 0-999 的整数`);
    }
    return parsed;
  };
  if (source.outlook === undefined && source.domain === undefined && source.temp === undefined) {
    return null;
  }
  return {
    outlook: source.outlook === undefined ? 0 : read("outlook"),
    domain: source.domain === undefined ? 0 : read("domain"),
    temp: source.temp === undefined ? 0 : read("temp")
  };
}

export function getUserRow(userId: string): UserRow | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  return row ?? null;
}

function getUserRowByName(username: string): UserRow | null {
  const row = getDb().prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  return row ?? null;
}

function countAdmins(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'")
    .get() as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

function normalizeUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";
  if (!USERNAME_PATTERN.test(username)) {
    throw invalid("用户名需为 3-32 位字母、数字或 _ . @ -");
  }
  return username.toLowerCase();
}

function normalizePassword(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("密码必须是字符串");
  }
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw invalid(`密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`);
  }
  return value;
}

export function listUsers(query?: string): AdminUserView[] {
  const keyword = query?.trim().toLowerCase() ?? "";
  const rows = getDb()
    .prepare(`
      SELECT u.*, (
        SELECT COUNT(*) FROM domain_mailboxes m
        WHERE m.assigned_user_id = u.id AND m.status = 'assigned'
      ) AS mailbox_count,
      (
        SELECT COUNT(*) FROM accounts a WHERE a.assigned_user_id = u.id
      ) AS outlook_count,
      (
        SELECT COUNT(*) FROM domain_mailboxes m
        JOIN domain_providers p ON p.id = m.provider_id
        WHERE m.assigned_user_id = u.id AND m.status = 'assigned' AND p.type = 'imap'
      ) AS domain_count,
      (
        SELECT COUNT(*) FROM domain_mailboxes m
        JOIN domain_providers p ON p.id = m.provider_id
        WHERE m.assigned_user_id = u.id AND m.status = 'assigned' AND p.type <> 'imap'
      ) AS temp_count
      FROM users u
      ORDER BY u.created_at ASC
    `)
    .all() as unknown as Array<
    UserRow & {
      mailbox_count: number;
      outlook_count: number;
      domain_count: number;
      temp_count: number;
    }
  >;
  return rows
    .filter((row) => !keyword || row.username.toLowerCase().includes(keyword))
    .map((row) => ({
      ...toSessionUser(row),
      mailboxCount: Number(row.mailbox_count ?? 0),
      mailboxCounts: {
        outlook: Number(row.outlook_count ?? 0),
        domain: Number(row.domain_count ?? 0),
        temp: Number(row.temp_count ?? 0)
      },
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    }));
}

export function createUser(input: {
  username: unknown;
  password: unknown;
  role?: unknown;
  mailboxQuota?: unknown;
  quotas?: unknown;
  resetUsage?: unknown;
  canOnlinePlay?: unknown;
}): AdminUserView {
  const username = normalizeUsername(input.username);
  const password = normalizePassword(input.password);
  const role: Role = input.role === "admin" ? "admin" : "user";
  const quota = input.mailboxQuota === undefined ? 1 : Number(input.mailboxQuota);
  if (!Number.isInteger(quota) || quota < 0 || quota > 999) {
    throw invalid("邮箱配额需为 0-999 的整数");
  }
  const buckets = parseQuotaBuckets(input.quotas);
  if (getUserRowByName(username)) {
    throw conflict("用户名已存在");
  }
  const timestamp = nowIso();
  const id = randomUUID();
  const canOnlinePlay = input.canOnlinePlay === true || input.canOnlinePlay === "true" || input.canOnlinePlay === 1;
  getDb()
    .prepare(`
      INSERT INTO users
        (id, username, password_hash, role, status, mailbox_quota, quota_outlook, quota_domain, quota_temp, can_online_play, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL)
    `)
    .run(
      id,
      username,
      hashPassword(password),
      role,
      quota,
      buckets?.outlook ?? quota,
      buckets?.domain ?? quota,
      buckets?.temp ?? quota,
      canOnlinePlay ? 1 : 0,
      timestamp,
      timestamp
    );
  const row = getUserRow(id);
  if (!row) {
    throw notFound("用户创建失败");
  }
  return {
    ...toSessionUser(row),
    mailboxCount: 0,
    mailboxCounts: { outlook: 0, domain: 0, temp: 0 },
    createdAt: row.created_at,
    lastLoginAt: null
  };
}

export function updateUser(
  userId: string,
  patch: {
    password?: unknown;
    role?: unknown;
    status?: unknown;
    mailboxQuota?: unknown;
    quotas?: unknown;
    resetUsage?: unknown;
    canOnlinePlay?: unknown;
  }
): AdminUserView {
  const row = getUserRow(userId);
  if (!row) {
    throw notFound("用户不存在");
  }

  const nextRole: Role | undefined =
    patch.role === undefined ? undefined : patch.role === "admin" ? "admin" : patch.role === "user" ? "user" : undefined;
  if (patch.role !== undefined && nextRole === undefined) {
    throw invalid("角色必须是 admin 或 user");
  }
  const nextStatus: UserStatus | undefined =
    patch.status === undefined
      ? undefined
      : patch.status === "active"
        ? "active"
        : patch.status === "disabled"
          ? "disabled"
          : undefined;
  if (patch.status !== undefined && nextStatus === undefined) {
    throw invalid("状态必须是 active 或 disabled");
  }

  const losesAdmin =
    row.role === "admin" &&
    row.status === "active" &&
    ((nextRole !== undefined && nextRole !== "admin") || (nextStatus !== undefined && nextStatus !== "active"));
  if (losesAdmin && countAdmins() <= 1) {
    throw conflict("至少需要保留一个启用状态的管理员");
  }

  let quota: number | undefined;
  if (patch.mailboxQuota !== undefined) {
    const parsed = Number(patch.mailboxQuota);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 999) {
      throw invalid("邮箱配额需为 0-999 的整数");
    }
    quota = parsed;
  }

  const buckets = parseQuotaBuckets(patch.quotas);
  const resetUsage = patch.resetUsage === true || patch.resetUsage === "true";
  const nextCanOnlinePlay: number | undefined =
    patch.canOnlinePlay === undefined
      ? undefined
      : patch.canOnlinePlay === true || patch.canOnlinePlay === "true" || patch.canOnlinePlay === 1
        ? 1
        : 0;

  let passwordHash: string | undefined;
  if (patch.password !== undefined) {
    passwordHash = hashPassword(normalizePassword(patch.password));
  }

  const timestamp = nowIso();
  getDb()
    .prepare(`
      UPDATE users SET
        role = ?, status = ?, mailbox_quota = ?, password_hash = ?,
        quota_outlook = ?, quota_domain = ?, quota_temp = ?, can_online_play = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      nextRole ?? row.role,
      nextStatus ?? row.status,
      quota ?? row.mailbox_quota,
      passwordHash ?? row.password_hash,
      buckets?.outlook ?? row.quota_outlook,
      buckets?.domain ?? row.quota_domain,
      buckets?.temp ?? row.quota_temp,
      nextCanOnlinePlay ?? Number(row.can_online_play ?? 0),
      timestamp,
      userId
    );

  if (resetUsage) {
    getDb()
      .prepare("UPDATE users SET used_outlook = 0, used_domain = 0, used_temp = 0, updated_at = ? WHERE id = ?")
      .run(timestamp, userId);
  }

  // 改密或停用后，旧会话立即失效。
  if (passwordHash || (nextStatus !== undefined && nextStatus !== "active")) {
    getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  const updated = getUserRow(userId);
  if (!updated) {
    throw notFound("用户不存在");
  }
  const counts = getDb()
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounts a WHERE a.assigned_user_id = ?) AS outlook_count,
        (SELECT COUNT(*) FROM domain_mailboxes m JOIN domain_providers p ON p.id = m.provider_id
          WHERE m.assigned_user_id = ? AND m.status = 'assigned' AND p.type = 'imap') AS domain_count,
        (SELECT COUNT(*) FROM domain_mailboxes m JOIN domain_providers p ON p.id = m.provider_id
          WHERE m.assigned_user_id = ? AND m.status = 'assigned' AND p.type <> 'imap') AS temp_count
    `)
    .get(userId, userId, userId) as
    | { outlook_count: number; domain_count: number; temp_count: number }
    | undefined;
  const mailboxCounts: QuotaBuckets = {
    outlook: Number(counts?.outlook_count ?? 0),
    domain: Number(counts?.domain_count ?? 0),
    temp: Number(counts?.temp_count ?? 0)
  };
  return {
    ...toSessionUser(updated),
    mailboxCount: mailboxCounts.outlook + mailboxCounts.domain + mailboxCounts.temp,
    mailboxCounts,
    createdAt: updated.created_at,
    lastLoginAt: updated.last_login_at
  };
}

export function deleteUser(userId: string, actorId: string): void {
  if (userId === actorId) {
    throw conflict("不能删除当前登录的账号");
  }
  const row = getUserRow(userId);
  if (!row) {
    throw notFound("用户不存在");
  }
  if (row.role === "admin" && row.status === "active" && countAdmins() <= 1) {
    throw conflict("至少需要保留一个启用状态的管理员");
  }
  const timestamp = nowIso();
  getDb()
    .prepare(`
      UPDATE domain_mailboxes
      SET assigned_user_id = NULL, status = 'available', assigned_at = NULL, updated_at = ?
      WHERE assigned_user_id = ?
    `)
    .run(timestamp, userId);
  getDb()
    .prepare("UPDATE accounts SET assigned_user_id = NULL, assigned_at = NULL, updated_at = ? WHERE assigned_user_id = ?")
    .run(timestamp, userId);
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

function loginKey(ip: string, username: string): string {
  return `${ip}|${username}`;
}

function assertNotLocked(key: string) {
  const attempt = loginAttempts.get(key);
  if (!attempt) {
    return;
  }
  if (attempt.lockedUntil > Date.now()) {
    const seconds = Math.ceil((attempt.lockedUntil - Date.now()) / 1_000);
    throw rateLimited(`登录失败次数过多，请 ${seconds} 秒后重试`);
  }
  if (attempt.lockedUntil > 0 && attempt.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
  }
}

function recordLoginFailure(key: string) {
  const attempt = loginAttempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  attempt.failures += 1;
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    attempt.failures = 0;
    attempt.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, attempt);
}

export function verifyCredentials(usernameInput: unknown, passwordInput: unknown, ip: string): UserRow {
  const username = typeof usernameInput === "string" ? usernameInput.trim().toLowerCase() : "";
  const password = typeof passwordInput === "string" ? passwordInput : "";
  if (!username || !password) {
    throw invalid("请填写用户名和密码");
  }
  const key = loginKey(ip, username);
  assertNotLocked(key);

  const row = getUserRowByName(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    recordLoginFailure(key);
    throw unauthorized("用户名或密码错误");
  }
  if (row.status !== "active") {
    throw forbidden("账号已被停用，请联系管理员");
  }
  loginAttempts.delete(key);
  return row;
}

export interface SessionToken {
  token: string;
  expiresAt: string;
}

export function createSession(userId: string, meta: { userAgent?: string; ip?: string }): SessionToken {
  const token = randomBytes(32).toString("base64url");
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    userId,
    sha256(token),
    timestamp,
    expiresAt,
    timestamp,
    (meta.userAgent ?? "").slice(0, 512),
    (meta.ip ?? "").slice(0, 128)
  );
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, userId);
  return { token, expiresAt };
}

export function resolveSession(token: string): UserRow | null {
  const row = getDb()
    .prepare(`
      SELECT u.*, s.expires_at AS session_expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `)
    .get(sha256(token)) as (UserRow & { session_expires_at: string }) | undefined;
  if (!row) {
    return null;
  }
  if (row.session_expires_at <= nowIso()) {
    getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  if (row.status !== "active") {
    return null;
  }
  getDb().prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso(), sha256(token));
  return row;
}

export function destroySession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function changeOwnPassword(userId: string, currentPassword: unknown, nextPassword: unknown): void {
  const row = getUserRow(userId);
  if (!row) {
    throw unauthorized();
  }
  if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, row.password_hash)) {
    throw invalid("当前密码不正确");
  }
  const password = normalizePassword(nextPassword);
  getDb()
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(password), nowIso(), userId);
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/** 首次启动没有账号时自动建管理员；密码来自 MAILDECK_ADMIN_PASSWORD，缺省随机生成并打印一次。 */
export function ensureAdminUser(): { created: boolean; username: string; password?: string } {
  const total = getDb().prepare("SELECT COUNT(*) AS total FROM users").get() as { total: number } | undefined;
  if (Number(total?.total ?? 0) > 0) {
    return { created: false, username: serverConfig.adminUsername };
  }
  const generated = !serverConfig.adminPassword;
  const password = serverConfig.adminPassword || randomBytes(9).toString("base64url");
  const username = serverConfig.adminUsername || "admin";
  createUser({ username, password, role: "admin", mailboxQuota: 5 });
  console.log("");
  console.log("==================== MailDeck 初始化 ====================");
  console.log(`已创建管理员账号：${username}`);
  console.log(generated ? `初始密码（仅显示这一次，请立即登录修改）：${password}` : "密码取自环境变量 MAILDECK_ADMIN_PASSWORD");
  console.log("登录入口：http://<服务地址>/  登录后请到「用户管理」修改密码");
  console.log("========================================================");
  console.log("");
  return { created: true, username, password: generated ? password : undefined };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1_000);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function isSecureRequest(protocol: string, forwardedProto: string | string[] | undefined): boolean {
  const forwarded = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return (forwarded ?? protocol).split(",")[0]?.trim() === "https";
}

/** 从请求头解析身份：优先会话 Cookie，其次兼容旧桌面端的 Bearer Token。 */
export function readIdentity(headers: {
  cookie?: string;
  authorization?: string;
}): Identity | null {
  const token = readCookie(headers.cookie, SESSION_COOKIE);
  if (token) {
    const row = resolveSession(token);
    if (row) {
      return { userId: row.id, username: row.username, role: row.role === "admin" ? "admin" : "user", legacy: false };
    }
  }
  if (serverConfig.apiToken && headers.authorization === `Bearer ${serverConfig.apiToken}`) {
    return { userId: null, username: "api-token", role: "admin", legacy: true };
  }
  return null;
}

const identities = new WeakMap<object, Identity>();

export function setIdentity(target: object, identity: Identity): void {
  identities.set(target, identity);
}

export function getIdentity(target: object): Identity | null {
  return identities.get(target) ?? null;
}

export function requireIdentity(target: object): Identity {
  const identity = getIdentity(target);
  if (!identity) {
    throw unauthorized();
  }
  return identity;
}

export function requireAdminIdentity(target: object): Identity {
  const identity = requireIdentity(target);
  if (identity.role !== "admin") {
    throw forbidden("需要管理员权限");
  }
  return identity;
}

/** /api/me/* 的处理函数用它拿到完整用户行；旧 Token 身份没有用户行，直接拒绝。 */
export function requireUserRow(target: object): UserRow {
  const identity = requireIdentity(target);
  if (!identity.userId) {
    throw forbidden("请使用账号登录后访问");
  }
  const row = getUserRow(identity.userId);
  if (!row || row.status !== "active") {
    throw unauthorized("登录状态已失效，请重新登录");
  }
  return row;
}

export function assertSessionUser(row: UserRow): UserRow {
  if (row.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", "账号已被停用");
  }
  return row;
}
