import { randomUUID } from "node:crypto";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  ImportPreviewResult,
  ImportResult
} from "../../electron/shared/ipc-contracts.js";
import { encryptSecret } from "./crypto.js";
import { getDb, transaction, type AccountRow } from "./db.js";

const IMPORT_MAX_ROWS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_FIELD_LIMITS = {
  clientId: 256,
  refreshToken: 32_768,
  remark: 1_000,
  group: 200,
  tag: 50,
  tags: 20
} as const;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikeRefreshToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("M.") && trimmed.length > 80;
}

function looksLikeAccessToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("Ew") && trimmed.length > 80 && !trimmed.includes(".");
}

function normalizeTags(values: string[] | undefined) {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))];
}

function parseTags(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeTags(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Old rows have no tags; invalid JSON is treated as an empty tag list.
  }
  return [];
}

export function validateImportInput(input: AccountInput, rowNumber: number) {
  const email = normalizeEmail(input.email || "");
  const clientId = (input.clientId || "").trim();
  const refreshToken = (input.refreshToken || "").trim();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!email || !clientId || !refreshToken) {
    errors.push(`第 ${rowNumber} 行缺少 email、client_id 或 refresh_token`);
    return { email, clientId, refreshToken, tags: [], errors, warnings };
  }

  if (!isEmailLike(email)) {
    errors.push(`第 ${rowNumber} 行 email 格式不正确`);
  }
  if (!UUID_PATTERN.test(clientId)) {
    errors.push(`第 ${rowNumber} 行 client_id 不是 UUID，可能字段顺序写错`);
  }
  if (UUID_PATTERN.test(refreshToken)) {
    errors.push(`第 ${rowNumber} 行 refresh_token 看起来像 client_id，疑似字段顺序错误`);
  }
  if (looksLikeRefreshToken(clientId)) {
    errors.push(`第 ${rowNumber} 行 client_id 看起来像 refresh_token，疑似字段顺序错误`);
  }
  if (looksLikeAccessToken(refreshToken)) {
    errors.push(`第 ${rowNumber} 行 refresh_token 看起来像 access_token，请导入 refresh_token`);
  } else if (!looksLikeRefreshToken(refreshToken)) {
    warnings.push(`第 ${rowNumber} 行 refresh_token 不像常见 Microsoft refresh token，请确认不是复制了密码或 access token`);
  }

  if (clientId.length > IMPORT_FIELD_LIMITS.clientId) {
    errors.push(`第 ${rowNumber} 行 client_id 超过 ${IMPORT_FIELD_LIMITS.clientId} 字符`);
  }
  if (refreshToken.length > IMPORT_FIELD_LIMITS.refreshToken) {
    errors.push(`第 ${rowNumber} 行 refresh_token 超过 ${IMPORT_FIELD_LIMITS.refreshToken} 字符`);
  }

  const remark = (input.remark || "").trim();
  if (remark.length > IMPORT_FIELD_LIMITS.remark) {
    errors.push(`第 ${rowNumber} 行备注超过 ${IMPORT_FIELD_LIMITS.remark} 字符`);
  }
  const group = (input.group || "").trim();
  if (group.length > IMPORT_FIELD_LIMITS.group) {
    errors.push(`第 ${rowNumber} 行分组超过 ${IMPORT_FIELD_LIMITS.group} 字符`);
  }

  const tags = normalizeTags(input.tags);
  if (tags.length > IMPORT_FIELD_LIMITS.tags) {
    errors.push(`第 ${rowNumber} 行标签超过 ${IMPORT_FIELD_LIMITS.tags} 个`);
  }
  if (tags.some((tag) => tag.length > IMPORT_FIELD_LIMITS.tag)) {
    errors.push(`第 ${rowNumber} 行存在超过 ${IMPORT_FIELD_LIMITS.tag} 字符的标签`);
  }

  return { email, clientId, refreshToken, remark, group, tags, errors, warnings };
}

function rowToView(row: AccountRow): AccountView {
  return {
    id: row.id,
    email: row.email,
    clientId: row.client_id,
    remark: row.remark || "",
    group: row.group_name || "",
    tags: parseTags(row.tags_json),
    ...(row.auth_mode ? { authMode: row.auth_mode } : {}),
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    lastRefreshedAt: row.last_refreshed_at,
    lastInboxCount: row.last_inbox_count || 0,
    lastMailAt: row.last_mail_at,
    lastMailCursor: row.last_mail_cursor,
    inboxFolderId: row.inbox_folder_id,
    graphDeltaLink: row.graph_delta_link,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getAccountRecord(accountId: string): AccountRow | null {
  const row = getDb()
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .get(accountId) as AccountRow | undefined;
  return row ?? null;
}

export function getAccountView(accountId: string): AccountView | null {
  const row = getAccountRecord(accountId);
  return row ? rowToView(row) : null;
}

export function listAccounts(): AccountView[] {
  const rows = getDb()
    .prepare("SELECT * FROM accounts ORDER BY created_at ASC")
    .all() as unknown as AccountRow[];
  return rows.map(rowToView);
}

export function previewAccounts(inputs: AccountInput[]): ImportPreviewResult {
  if (inputs.length > IMPORT_MAX_ROWS) {
    throw new Error(`单次导入不能超过 ${IMPORT_MAX_ROWS} 行`);
  }

  const existingEmails = new Set(
    (getDb().prepare("SELECT email FROM accounts").all() as unknown as Array<{ email: string }>).map(
      (row) => row.email
    )
  );
  const seenEmails = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  let valid = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const [index, input] of inputs.entries()) {
    const result = validateImportInput(input, index + 1);
    errors.push(...result.errors);
    warnings.push(...result.warnings);

    if (result.errors.length > 0) {
      invalid += 1;
      continue;
    }

    valid += 1;
    if (existingEmails.has(result.email) || seenEmails.has(result.email)) {
      duplicates += 1;
    }
    seenEmails.add(result.email);
  }

  return {
    total: inputs.length,
    valid,
    duplicates,
    invalid,
    errors,
    warnings
  };
}

export function upsertAccounts(inputs: AccountInput[]): ImportResult {
  if (inputs.length > IMPORT_MAX_ROWS) {
    throw new Error(`单次导入不能超过 ${IMPORT_MAX_ROWS} 行`);
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  transaction(() => {
    for (const [index, input] of inputs.entries()) {
      const result = validateImportInput(input, index + 1);
      if (result.errors.length > 0) {
        skipped += 1;
        errors.push(...result.errors);
        continue;
      }

      const existing = getDb()
        .prepare("SELECT * FROM accounts WHERE email = ?")
        .get(result.email) as AccountRow | undefined;
      const timestamp = nowIso();

      if (existing) {
        getDb()
          .prepare(`
            UPDATE accounts SET
              client_id = ?,
              encrypted_refresh_token = ?,
              remark = ?,
              group_name = ?,
              tags_json = ?,
              status = 'untested',
              last_error = NULL,
              updated_at = ?
            WHERE id = ?
          `)
          .run(
            result.clientId,
            encryptSecret(result.refreshToken),
            result.remark || existing.remark,
            result.group || existing.group_name,
            result.tags.length > 0 ? JSON.stringify(result.tags) : existing.tags_json,
            timestamp,
            existing.id
          );
        updated += 1;
      } else {
        getDb()
          .prepare(`
            INSERT INTO accounts (
              id, email, client_id, encrypted_refresh_token, remark, group_name, tags_json,
              status, last_inbox_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'untested', 0, ?, ?)
          `)
          .run(
            randomUUID(),
            result.email,
            result.clientId,
            encryptSecret(result.refreshToken),
            result.remark || "",
            result.group || "",
            JSON.stringify(result.tags),
            timestamp,
            timestamp
          );
        imported += 1;
      }
    }
  });

  return {
    imported,
    updated,
    skipped,
    errors,
    accounts: listAccounts()
  };
}

export function updateAccount(input: AccountUpdateInput): AccountView {
  const account = getAccountRecord(input.id);
  if (!account) {
    throw new Error("账号不存在");
  }

  const email = normalizeEmail(input.email || "");
  const clientId = (input.clientId || "").trim();
  if (!email || !clientId) {
    throw new Error("邮箱和 Client ID 不能为空");
  }

  const duplicate = getDb()
    .prepare("SELECT id FROM accounts WHERE email = ? AND id <> ?")
    .get(email, input.id) as { id: string } | undefined;
  if (duplicate) {
    throw new Error("邮箱已存在");
  }

  const refreshToken = (input.refreshToken || "").trim();
  const credentialsChanged =
    email !== account.email || clientId !== account.client_id || Boolean(refreshToken);
  const tags = input.tags ? normalizeTags(input.tags) : parseTags(account.tags_json);

  getDb()
    .prepare(`
      UPDATE accounts SET
        email = ?,
        client_id = ?,
        encrypted_refresh_token = ?,
        remark = ?,
        group_name = ?,
        tags_json = ?,
        status = ?,
        last_error = ?,
        auth_mode = ?,
        updated_at = ?
      WHERE id = ?
    `)
    .run(
      email,
      clientId,
      refreshToken ? encryptSecret(refreshToken) : account.encrypted_refresh_token,
      (input.remark || "").trim(),
      (input.group || "").trim(),
      JSON.stringify(tags),
      credentialsChanged ? "untested" : account.status,
      credentialsChanged ? null : account.last_error,
      credentialsChanged ? null : account.auth_mode,
      nowIso(),
      input.id
    );

  return getAccountView(input.id)!;
}

export function deleteAccount(accountId: string): AccountView[] {
  if (!getAccountRecord(accountId)) {
    throw new Error("账号不存在");
  }
  getDb().prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  return listAccounts();
}

export interface AccountStatePatch {
  status?: AccountRow["status"];
  lastError?: string | null;
  lastCheckedAt?: string | null;
  lastRefreshedAt?: string | null;
  lastInboxCount?: number;
  lastMailAt?: string | null;
  lastMailCursor?: string | null;
  inboxFolderId?: string | null;
  graphDeltaLink?: string | null;
  authMode?: "graph" | "imap" | null;
}

export function updateAccountState(accountId: string, patch: AccountStatePatch): AccountView {
  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  const next = {
    status: patch.status ?? account.status,
    lastError: patch.lastError !== undefined ? patch.lastError : account.last_error,
    lastCheckedAt: patch.lastCheckedAt !== undefined ? patch.lastCheckedAt : account.last_checked_at,
    lastRefreshedAt:
      patch.lastRefreshedAt !== undefined ? patch.lastRefreshedAt : account.last_refreshed_at,
    lastInboxCount:
      patch.lastInboxCount !== undefined ? patch.lastInboxCount : account.last_inbox_count,
    lastMailAt: patch.lastMailAt !== undefined ? patch.lastMailAt : account.last_mail_at,
    lastMailCursor:
      patch.lastMailCursor !== undefined ? patch.lastMailCursor : account.last_mail_cursor,
    inboxFolderId:
      patch.inboxFolderId !== undefined ? patch.inboxFolderId : account.inbox_folder_id,
    graphDeltaLink:
      patch.graphDeltaLink !== undefined ? patch.graphDeltaLink : account.graph_delta_link,
    authMode: patch.authMode !== undefined ? patch.authMode : account.auth_mode
  };

  getDb()
    .prepare(`
      UPDATE accounts SET
        status = ?, last_error = ?, last_checked_at = ?, last_refreshed_at = ?,
        last_inbox_count = ?, last_mail_at = ?, last_mail_cursor = ?,
        inbox_folder_id = ?, graph_delta_link = ?, auth_mode = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      next.status,
      next.lastError,
      next.lastCheckedAt,
      next.lastRefreshedAt,
      next.lastInboxCount,
      next.lastMailAt,
      next.lastMailCursor,
      next.inboxFolderId,
      next.graphDeltaLink,
      next.authMode,
      nowIso(),
      accountId
    );

  return getAccountView(accountId)!;
}
