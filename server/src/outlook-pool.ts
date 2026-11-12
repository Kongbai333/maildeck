import { parseAccountImport } from "../../electron/main/import-parser.js";
import { deleteAccount, listAccounts, upsertAccounts } from "./account-service.js";
import { consumeQuota, getQuotaUsage, getQuotas, getUserRow, type UserRow } from "./auth-service.js";
import { getDb, transaction } from "./db.js";
import { conflict, invalid, notFound } from "./http-utils.js";

export type PoolStatus = "available" | "assigned" | "disabled";

export interface OutlookPoolItem {
  id: string;
  email: string;
  remark: string;
  status: PoolStatus;
  assignedUserId: string | null;
  assignedUsername: string | null;
  assignedAt: string | null;
  tags: string[];
  /** pool=池子领取 / admin=管理员分配 / import=自助导入（不占配额） */
  assignedVia: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

interface AccountPoolRow {
  id: string;
  email: string;
  remark: string;
  status: string;
  created_at: string;
  last_checked_at: string | null;
  last_error: string | null;
  assigned_user_id: string | null;
  assigned_at: string | null;
  assigned_via?: string | null;
  tags_json?: string | null;
  assigned_username?: string | null;
}

const POOL_SELECT = `
  SELECT a.id, a.email, a.remark, a.status, a.created_at, a.last_checked_at, a.last_error,
         a.assigned_user_id, a.assigned_at, a.assigned_via, a.tags_json, u.username AS assigned_username
  FROM accounts a
  LEFT JOIN users u ON u.id = a.assigned_user_id
`;

function parseAccountTags(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function nowIso() {
  return new Date().toISOString();
}

function poolStatus(row: AccountPoolRow): PoolStatus {
  if (row.status === "invalid") {
    return "disabled";
  }
  return row.assigned_user_id ? "assigned" : "available";
}

function toItem(row: AccountPoolRow): OutlookPoolItem {
  return {
    id: row.id,
    email: row.email,
    remark: row.remark,
    status: poolStatus(row),
    assignedUserId: row.assigned_user_id,
    assignedUsername: row.assigned_username ?? null,
    assignedAt: row.assigned_at,
    tags: parseAccountTags(row.tags_json),
    assignedVia: row.assigned_via ?? null,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error
  };
}

export function isOutlookAccountId(id: string): boolean {
  const row = getDb().prepare("SELECT 1 AS hit FROM accounts WHERE id = ?").get(id) as { hit: number } | undefined;
  return Boolean(row);
}

export function getOutlookItem(accountId: string): OutlookPoolItem {
  const row = getDb().prepare(`${POOL_SELECT} WHERE a.id = ?`).get(accountId) as AccountPoolRow | undefined;
  if (!row) {
    throw notFound("Outlook 账号不存在");
  }
  return toItem(row);
}

export function listOutlookPool(filter: { status?: string; q?: string } = {}): OutlookPoolItem[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.status && filter.status !== "all") {
    if (filter.status === "available") {
      conditions.push("a.assigned_user_id IS NULL AND a.status <> 'invalid'");
    } else if (filter.status === "assigned") {
      conditions.push("a.assigned_user_id IS NOT NULL");
    } else if (filter.status === "disabled") {
      conditions.push("a.status = 'invalid'");
    }
  }
  if (filter.q?.trim()) {
    conditions.push("(lower(a.email) LIKE ? OR lower(a.remark) LIKE ?)");
    const like = `%${filter.q.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`${POOL_SELECT}${where} ORDER BY a.created_at DESC`)
    .all(...params) as unknown as AccountPoolRow[];
  return rows.map(toItem);
}

/** 占用配额的 Outlook 数量：用户自助导入（assigned_via='import'）不占配额。 */
export function outlookAssignedCount(userId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS total FROM accounts WHERE assigned_user_id = ? AND COALESCE(assigned_via, '') <> 'import'"
    )
    .get(userId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/** 全部归属该用户的 Outlook 账号数（含不占配额的导入）。 */
export function outlookOwnedCount(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM accounts WHERE assigned_user_id = ?")
    .get(userId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function outlookPoolCounts(): { total: number; available: number; assigned: number; disabled: number } {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN assigned_user_id IS NULL AND status <> 'invalid' THEN 1 ELSE 0 END) AS available,
             SUM(CASE WHEN assigned_user_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
             SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS disabled
      FROM accounts
    `)
    .get() as { total: number; available: number | null; assigned: number | null; disabled: number | null } | undefined;
  return {
    total: Number(row?.total ?? 0),
    available: Number(row?.available ?? 0),
    assigned: Number(row?.assigned ?? 0),
    disabled: Number(row?.disabled ?? 0)
  };
}

/** 导入文本里的空行与 # 注释行直接忽略。 */
function prepareImportText(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    })
    .join("\n");
}

/**
 * 管理员批量导入 Outlook 账号。
 * `userId` 可选：导入后直接分配给该用户（默认不分配，留在池子里）。
 */
export function importOutlookAccounts(
  text: string,
  userId?: string | null
): { imported: number; skipped: number; assigned: number; errors: string[] } {
  const inputs = parseAccountImport(prepareImportText(text));
  if (inputs.length === 0) {
    return { imported: 0, skipped: 0, assigned: 0, errors: ["没有解析到有效账号"] };
  }
  const result = upsertAccounts(inputs);
  const errors = [...result.errors];
  let assigned = 0;
  if (userId) {
    const target = getUserRow(userId);
    if (!target) {
      throw notFound("要分配的用户不存在");
    }
    if (target.status !== "active") {
      throw conflict("该用户已被停用，无法分配邮箱");
    }
    for (const input of inputs) {
      const row = getDb()
        .prepare("SELECT id, assigned_user_id FROM accounts WHERE email = ?")
        .get(input.email.trim().toLowerCase()) as { id: string; assigned_user_id: string | null } | undefined;
      if (!row) {
        continue;
      }
      if (row.assigned_user_id && row.assigned_user_id !== userId) {
        errors.push(`${input.email}：已归属其他用户，未改派`);
        continue;
      }
      if (row.assigned_user_id === userId) {
        continue;
      }
      assignOutlookAccount(row.id, userId);
      assigned += 1;
    }
  }
  return {
    imported: result.imported + result.updated,
    skipped: result.skipped,
    assigned,
    errors: errors.slice(0, 50)
  };
}

/** 用户自助导入 Outlook 账号：**不占配额**（quotaSkipped 恒为 0，字段保留兼容）。 */
export function importOutlookForUser(
  user: UserRow,
  text: string
): { imported: number; skipped: number; quotaSkipped: number; errors: string[] } {
  const inputs = parseAccountImport(prepareImportText(text));
  if (inputs.length === 0) {
    throw invalid("没有解析到有效的 Outlook 账号（邮箱、密码、clientId、refreshToken 四段，用四个减号连接）");
  }
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const input of inputs) {
    try {
      const result = upsertAccounts([input]);
      if (result.imported + result.updated === 0) {
        skipped += 1;
        errors.push(...result.errors);
        continue;
      }
      const row = getDb()
        .prepare("SELECT id, assigned_user_id FROM accounts WHERE email = ?")
        .get(input.email.trim().toLowerCase()) as { id: string; assigned_user_id: string | null } | undefined;
      if (!row) {
        skipped += 1;
        continue;
      }
      if (row.assigned_user_id && row.assigned_user_id !== user.id) {
        skipped += 1;
        errors.push(`${input.email}：该账号已被其他用户领取`);
        continue;
      }
      const timestamp = new Date().toISOString();
      getDb()
        .prepare(
          "UPDATE accounts SET assigned_user_id = ?, assigned_at = ?, assigned_via = 'import', updated_at = ? WHERE id = ?"
        )
        .run(user.id, row.assigned_user_id === user.id ? timestamp : timestamp, timestamp, row.id);
      imported += 1;
    } catch (error) {
      skipped += 1;
      errors.push(`${input.email}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, skipped, quotaSkipped: 0, errors: errors.slice(0, 50) };
}

export function claimOutlookAccount(user: UserRow): OutlookPoolItem {
  const quota = getQuotas(user).outlook;
  const used = getQuotaUsage(user).outlook;
  return transaction(() => {
    const current = used;
    if (quota <= 0) {
      throw conflict("当前账号没有 Outlook 邮箱配额，请联系管理员");
    }
    if (current >= quota) {
      throw conflict(`Outlook 邮箱已达配额（${quota} 个），请先释放或联系管理员提高配额`);
    }
    const candidate = getDb()
      .prepare(`
        SELECT id FROM accounts
        WHERE assigned_user_id IS NULL AND status <> 'invalid'
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as { id: string } | undefined;
    if (!candidate) {
      throw conflict("Outlook 账号池暂无可用账号，请联系管理员导入");
    }
    const timestamp = nowIso();
    getDb()
      .prepare(
        "UPDATE accounts SET assigned_user_id = ?, assigned_at = ?, assigned_via = 'pool', updated_at = ? WHERE id = ?"
      )
      .run(user.id, timestamp, timestamp, candidate.id);
    consumeQuota(user.id, "outlook");
    return getOutlookItem(candidate.id);
  });
}

export function releaseOutlookAccount(userId: string, accountId: string): void {
  const row = getDb()
    .prepare("SELECT id, assigned_user_id FROM accounts WHERE id = ?")
    .get(accountId) as { id: string; assigned_user_id: string | null } | undefined;
  if (!row || row.assigned_user_id !== userId) {
    throw notFound("邮箱不存在");
  }
  const timestamp = nowIso();
  getDb()
    .prepare(
      "UPDATE accounts SET assigned_user_id = NULL, assigned_at = NULL, assigned_via = NULL, updated_at = ? WHERE id = ?"
    )
    .run(timestamp, accountId);
}

export function assignOutlookAccount(accountId: string, targetUserId: string | null): OutlookPoolItem {
  getOutlookItem(accountId);
  const timestamp = nowIso();
  if (targetUserId) {
    const target = getDb().prepare("SELECT * FROM users WHERE id = ?").get(targetUserId) as UserRow | undefined;
    if (!target) {
      throw notFound("用户不存在");
    }
    if (target.status !== "active") {
      throw conflict("该用户已被停用，无法分配邮箱");
    }
    const quota = getQuotas(target).outlook;
    if (getQuotaUsage(target).outlook >= quota) {
      throw conflict(`该用户 Outlook 配额已满（${quota} 个），请先提高配额或回收`);
    }
  }
  getDb()
    .prepare(
      "UPDATE accounts SET assigned_user_id = ?, assigned_at = ?, assigned_via = ?, updated_at = ? WHERE id = ?"
    )
    .run(targetUserId, targetUserId ? timestamp : null, targetUserId ? "admin" : null, timestamp, accountId);
  if (targetUserId) {
    consumeQuota(targetUserId, "outlook");
  }
  return getOutlookItem(accountId);
}

export function deleteOutlookAccount(accountId: string): void {
  getOutlookItem(accountId);
  deleteAccount(accountId);
}

export function listUserOutlookAccounts(userId: string): OutlookPoolItem[] {
  const rows = getDb()
    .prepare(`${POOL_SELECT} WHERE a.assigned_user_id = ? ORDER BY a.assigned_at ASC`)
    .all(userId) as unknown as AccountPoolRow[];
  return rows.map(toItem);
}

/** 管理端账号列表（旧接口用），保留以兼容桌面端。 */
export function listLegacyAccounts() {
  return listAccounts();
}
