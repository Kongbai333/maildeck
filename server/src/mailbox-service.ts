import { randomUUID } from "node:crypto";
import { consumeQuota, getUserRow, getQuotaUsage, getQuotas, type UserRow } from "./auth-service.js";
import { serverConfig } from "./config.js";
import { getDb, transaction } from "./db.js";
import {
  clearMailbox,
  deleteMailboxMessage,
  generateMailboxBatch,
  getMailboxMessage,
  getProviderOption,
  listMailboxMessages,
  listProviderOptions,
  upsertMailboxRow,
  type ProviderOptionView
} from "./domain-service.js";
import { conflict, HttpError, invalid, notFound } from "./http-utils.js";
import {
  dropListCache,
  dropMessageFromCache,
  readDetailCache,
  readListCache,
  writeDetailCache,
  writeListCache
} from "./mail-cache-service.js";
import { getMessage as getAccountMessage, listMessages as listAccountMessages } from "./mail-service.js";
import {
  assignOutlookAccount,
  claimOutlookAccount,
  deleteOutlookAccount,
  isOutlookAccountId,
  listOutlookPool,
  listUserOutlookAccounts,
  outlookPoolCounts,
  releaseOutlookAccount,
  type OutlookPoolItem
} from "./outlook-pool.js";

export type MailboxStatus = "available" | "assigned" | "disabled";

/** 三类邮箱：Outlook 账号池 / 域名邮箱 / 临时邮箱。 */
export type MailboxKind = "outlook" | "domain" | "temp";

export interface MailboxView {
  id: string;
  email: string;
  providerId: string;
  providerName: string;
  domain: string;
  remark: string;
  status: MailboxStatus;
  kind: MailboxKind;
  /** 用户自定义标签（如「已注册 GPT」）。 */
  tags: string[];
  /** true = 用户自助导入的 Outlook 账号，不占配额。 */
  quotaExempt: boolean;
  assignedAt: string | null;
  createdAt: string;
}

export interface AdminMailboxView extends MailboxView {
  assignedUserId: string | null;
  assignedUsername: string | null;
}

export interface MailboxRow {
  id: string;
  provider_id: string;
  email: string;
  prefix: string;
  domain: string;
  remark: string;
  status: string;
  tags_json?: string | null;
  assigned_user_id: string | null;
  assigned_at: string | null;
  created_at: string;
  updated_at: string;
  provider_name?: string | null;
  provider_type?: string | null;
  assigned_username?: string | null;
}

export interface Overview {
  users: { total: number; admins: number; active: number };
  mailboxes: { total: number; available: number; assigned: number; disabled: number };
  mailboxesByKind: { outlook: number; domain: number; temp: number };
  providers: { total: number; enabled: number };
  claimsToday: number;
}

const MAILBOX_SELECT = `
  SELECT m.*, p.name AS provider_name, p.type AS provider_type, u.username AS assigned_username
  FROM domain_mailboxes m
  LEFT JOIN domain_providers p ON p.id = m.provider_id
  LEFT JOIN users u ON u.id = m.assigned_user_id
`;

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(value: string | null | undefined): MailboxStatus {
  if (value === "assigned" || value === "disabled") {
    return value;
  }
  return "available";
}

function providerKind(providerType: string | null | undefined): MailboxKind {
  return providerType === "imap" ? "domain" : "temp";
}

function outlookToView(item: OutlookPoolItem): MailboxView {
  const [, domain = ""] = item.email.split("@");
  return {
    id: item.id,
    email: item.email,
    providerId: "",
    providerName: "Outlook",
    domain,
    remark: item.remark,
    status: item.status,
    kind: "outlook",
    tags: item.tags,
    quotaExempt: item.assignedVia === "import",
    assignedAt: item.assignedAt,
    createdAt: item.createdAt
  };
}

function outlookToAdminView(item: OutlookPoolItem): AdminMailboxView {
  return {
    ...outlookToView(item),
    assignedUserId: item.assignedUserId,
    assignedUsername: item.assignedUsername
  };
}

function toView(row: MailboxRow): MailboxView {
  return {
    id: row.id,
    email: row.email,
    providerId: row.provider_id,
    providerName: row.provider_name ?? "",
    domain: row.domain,
    remark: row.remark,
    status: normalizeStatus(row.status),
    kind: providerKind(row.provider_type),
    tags: parseTagsJson(row.tags_json),
    quotaExempt: false,
    assignedAt: row.assigned_at,
    createdAt: row.created_at
  };
}

function toAdminView(row: MailboxRow): AdminMailboxView {
  return {
    ...toView(row),
    assignedUserId: row.assigned_user_id,
    assignedUsername: row.assigned_username ?? null
  };
}

function logEvent(input: {
  mailboxId?: string | null;
  userId?: string | null;
  actorId?: string | null;
  action: string;
  detail?: string;
}): void {
  getDb()
    .prepare(`
      INSERT INTO mailbox_events (id, mailbox_id, user_id, actor_id, action, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      input.mailboxId ?? null,
      input.userId ?? null,
      input.actorId ?? null,
      input.action,
      (input.detail ?? "").slice(0, 512),
      nowIso()
    );
}

export function getMailboxRow(mailboxId: string): MailboxRow {
  const row = getDb()
    .prepare(`${MAILBOX_SELECT} WHERE m.id = ?`)
    .get(mailboxId) as MailboxRow | undefined;
  if (!row) {
    throw notFound("邮箱不存在");
  }
  return row;
}

export function getOwnedMailboxRow(userId: string, mailboxId: string): MailboxRow {
  const row = getDb()
    .prepare(`${MAILBOX_SELECT} WHERE m.id = ?`)
    .get(mailboxId) as MailboxRow | undefined;
  if (!row || row.assigned_user_id !== userId) {
    throw notFound("邮箱不存在");
  }
  return row;
}


function providerKindOfProviderId(providerId: string): MailboxKind {
  const row = getDb().prepare("SELECT type FROM domain_providers WHERE id = ?").get(providerId) as
    | { type: string }
    | undefined;
  return providerKind(row?.type);
}

export function listUserMailboxes(userId: string): MailboxView[] {
  const rows = getDb()
    .prepare(`${MAILBOX_SELECT} WHERE m.assigned_user_id = ? AND m.status = 'assigned' ORDER BY m.assigned_at ASC`)
    .all(userId) as unknown as MailboxRow[];
  return [...listUserOutlookAccounts(userId).map(outlookToView), ...rows.map(toView)];
}

export function listAdminMailboxes(
  filter: { status?: string; q?: string; kind?: string } = {}
): AdminMailboxView[] {
  const kind = filter.kind ?? "outlook";
  if (kind === "outlook" || kind === "all") {
    const outlook = listOutlookPool({ status: filter.status, q: filter.q }).map(outlookToAdminView);
    if (kind === "outlook") {
      return outlook;
    }
    return [...outlook, ...listDomainMailboxesByKind(filter, "all")];
  }
  if (kind === "domain" || kind === "temp") {
    return listDomainMailboxesByKind(filter, kind);
  }
  return listDomainMailboxesByKind(filter, "all");
}

function listDomainMailboxesByKind(
  filter: { status?: string; q?: string },
  kind: MailboxKind | "all"
): AdminMailboxView[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (kind === "domain") {
    conditions.push("p.type = 'imap'");
  } else if (kind === "temp") {
    conditions.push("p.type <> 'imap'");
  }
  if (filter.status && filter.status !== "all") {
    conditions.push("m.status = ?");
    params.push(filter.status);
  }
  if (filter.q?.trim()) {
    conditions.push("(lower(m.email) LIKE ? OR lower(m.remark) LIKE ?)");
    const like = `%${filter.q.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`${MAILBOX_SELECT}${where} ORDER BY m.created_at DESC`)
    .all(...params) as unknown as MailboxRow[];
  return rows.map(toAdminView);
}

export function listUserMailboxesForAdmin(userId: string): AdminMailboxView[] {
  const rows = getDb()
    .prepare(`${MAILBOX_SELECT} WHERE m.assigned_user_id = ? ORDER BY m.assigned_at ASC`)
    .all(userId) as unknown as MailboxRow[];
  return [...listUserOutlookAccounts(userId).map(outlookToAdminView), ...rows.map(toAdminView)];
}

export function getAdminMailboxViews(ids: string[]): AdminMailboxView[] {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) {
    return [];
  }
  const placeholders = unique.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(`${MAILBOX_SELECT} WHERE m.id IN (${placeholders}) ORDER BY m.created_at DESC`)
    .all(...unique) as unknown as MailboxRow[];
  return rows.map(toAdminView);
}

/** 领取只针对 Outlook 账号池；域名/临时邮箱由用户自助导入或生成。 */
export function claimMailbox(user: UserRow): MailboxView {
  return outlookToView(claimOutlookAccount(user));
}

export async function releaseMailbox(user: UserRow, mailboxId: string): Promise<void> {
  if (isOutlookAccountId(mailboxId)) {
    releaseOutlookAccount(user.id, mailboxId);
    logEvent({ mailboxId, userId: user.id, actorId: user.id, action: "release-outlook", detail: "" });
    return;
  }
  const row = getOwnedMailboxRow(user.id, mailboxId);
  const timestamp = nowIso();
  getDb()
    .prepare(`
      UPDATE domain_mailboxes
      SET assigned_user_id = NULL, status = 'available', assigned_at = NULL, updated_at = ?
      WHERE id = ?
    `)
    .run(timestamp, mailboxId);
  logEvent({ mailboxId, userId: user.id, actorId: user.id, action: "release", detail: row.email });
  // 释放时后台清空远端收件箱，避免下一个用户看到上一个人的验证码；失败不影响释放结果。
  if (serverConfig.releaseClearsInbox) {
    void clearMailbox(mailboxId).catch(() => undefined);
  }
}

export function assignMailbox(mailboxId: string, targetUserId: string | null, actorId: string): AdminMailboxView {
  if (isOutlookAccountId(mailboxId)) {
    return outlookToAdminView(assignOutlookAccount(mailboxId, targetUserId));
  }
  const row = getMailboxRow(mailboxId);
  const timestamp = nowIso();

  if (!targetUserId) {
    getDb()
      .prepare(`
        UPDATE domain_mailboxes
        SET assigned_user_id = NULL, status = 'available', assigned_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(timestamp, mailboxId);
    logEvent({ mailboxId, userId: row.assigned_user_id, actorId, action: "unassign", detail: row.email });
    return toAdminView(getMailboxRow(mailboxId));
  }

  const target = getUserRow(targetUserId);
  if (!target) {
    throw notFound("用户不存在");
  }
  if (target.status !== "active") {
    throw conflict("该用户已被停用，无法分配邮箱");
  }
  const kind = providerKind(row.provider_type);
  if (row.assigned_user_id !== target.id) {
    const quota = getQuotas(target)[kind];
    const current = getQuotaUsage(target)[kind];
    if (current >= quota) {
      throw conflict(`该用户${kind === "domain" ? "域名邮箱" : "临时邮箱"}配额已满（${quota} 个），请先提高配额或回收旧邮箱`);
    }
  }
  getDb()
    .prepare(`
      UPDATE domain_mailboxes
      SET assigned_user_id = ?, status = 'assigned', assigned_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(target.id, timestamp, timestamp, mailboxId);
  logEvent({ mailboxId, userId: target.id, actorId, action: "assign", detail: row.email });
  if (row.assigned_user_id !== target.id) {
    consumeQuota(target.id, kind);
  }
  return toAdminView(getMailboxRow(mailboxId));
}

export function updateMailbox(
  mailboxId: string,
  patch: { remark?: string; status?: "available" | "disabled" | "assigned" },
  actorId: string
): AdminMailboxView {
  if (isOutlookAccountId(mailboxId)) {
    throw conflict("Outlook 账号请在「Outlook 账号池」里分配或回收，不支持改状态");
  }
  const row = getMailboxRow(mailboxId);
  const timestamp = nowIso();
  if (patch.remark !== undefined) {
    getDb()
      .prepare("UPDATE domain_mailboxes SET remark = ?, updated_at = ? WHERE id = ?")
      .run(patch.remark.trim().slice(0, 500), timestamp, mailboxId);
  }
  if (patch.status === "disabled") {
    // 停用只关闭「可领取」，保留归属：重新启用时能原样回到该用户名下。
    getDb()
      .prepare("UPDATE domain_mailboxes SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(timestamp, mailboxId);
    logEvent({ mailboxId, userId: row.assigned_user_id, actorId, action: "status:disabled", detail: row.email });
  } else if (patch.status === "available") {
    getDb()
      .prepare(`
        UPDATE domain_mailboxes
        SET status = 'available', assigned_user_id = NULL, assigned_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(timestamp, mailboxId);
    logEvent({ mailboxId, userId: row.assigned_user_id, actorId, action: "status:available", detail: row.email });
  } else if (patch.status === "assigned") {
    if (!row.assigned_user_id) {
      throw conflict("该邮箱尚未分配，无法恢复为已分配状态");
    }
    getDb()
      .prepare("UPDATE domain_mailboxes SET status = 'assigned', updated_at = ? WHERE id = ?")
      .run(timestamp, mailboxId);
    logEvent({ mailboxId, userId: row.assigned_user_id, actorId, action: "status:assigned", detail: row.email });
  }
  return toAdminView(getMailboxRow(mailboxId));
}

export function deleteMailboxes(ids: string[], actorId: string): number {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) {
    throw invalid("请选择要删除的邮箱");
  }
  const db = getDb();
  const statement = db.prepare("DELETE FROM domain_mailboxes WHERE id = ?");
  let deleted = 0;
  transaction(() => {
    for (const id of unique) {
      if (isOutlookAccountId(id)) {
        deleteOutlookAccount(id);
        deleted += 1;
        continue;
      }
      const row = db.prepare("SELECT id, email FROM domain_mailboxes WHERE id = ?").get(id) as
        | { id: string; email: string }
        | undefined;
      if (!row) {
        continue;
      }
      statement.run(id);
      deleted += 1;
      logEvent({ mailboxId: id, actorId, action: "delete", detail: row.email });
    }
  });
  return deleted;
}

interface ParsedImportLine {
  address: string;
  remark: string;
}

function parseImportLines(
  text: string,
  maxLines: number
): { lines: ParsedImportLine[]; errors: string[]; duplicates: number } {
  const rawLines = text.split(/\r?\n/u);
  if (rawLines.length > maxLines) {
    throw invalid(`单次最多导入 ${maxLines} 行`);
  }
  const lines: ParsedImportLine[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [addressPart, ...remarkParts] = line.split(",");
    const address = (addressPart ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      errors.push(`格式不正确：${line.slice(0, 80)}`);
      continue;
    }
    if (seen.has(address)) {
      duplicates += 1;
      continue;
    }
    seen.add(address);
    lines.push({ address, remark: remarkParts.join(",").trim() });
  }
  return { lines, errors, duplicates };
}

/** 服务商能否读这个地址：域名邮箱必须在配置的域名下，临时邮箱要支持导入。 */
function assertImportAllowed(option: ProviderOptionView, address: string): void {
  if (!option.supportsImport) {
    throw new Error(`${option.typeLabel} 不支持导入已有地址，请改用「生成新地址」`);
  }
  if (option.kind === "domain" && option.domain) {
    const domain = address.split("@")[1] ?? "";
    if (domain !== option.domain) {
      throw new Error(`地址必须属于 ${option.domain}`);
    }
  }
}

function attachMailboxToUser(mailboxId: string, user: UserRow, action: string): void {
  const timestamp = nowIso();
  getDb()
    .prepare(`
      UPDATE domain_mailboxes
      SET assigned_user_id = ?, status = 'assigned', assigned_at = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(user.id, timestamp, timestamp, mailboxId);
  logEvent({ mailboxId, userId: user.id, actorId: user.id, action, detail: "" });
  const kind = providerKindOfMailboxId(mailboxId);
  if (kind) {
    consumeQuota(user.id, kind);
  }
}

function providerKindOfMailboxId(mailboxId: string): "domain" | "temp" | null {
  const row = getDb()
    .prepare(`
      SELECT p.type AS type FROM domain_mailboxes m
      JOIN domain_providers p ON p.id = m.provider_id
      WHERE m.id = ?
    `)
    .get(mailboxId) as { type: string } | undefined;
  if (!row) {
    return null;
  }
  return row.type === "imap" ? "domain" : "temp";
}

export function importMailboxes(input: { providerId: string; text: string; actorId: string }): {
  imported: number;
  skipped: number;
  errors: string[];
} {
  const option = getProviderOption(input.providerId);
  if (!option.supportsImport) {
    throw conflict(`${option.typeLabel} 不支持导入已有地址，请改用「生成」`);
  }
  const { lines, errors, duplicates } = parseImportLines(input.text, 2_000);
  let imported = 0;
  let skipped = errors.length + duplicates;
  for (const line of lines) {
    try {
      assertImportAllowed(option, line.address);
      const result = upsertMailboxRow({
        providerId: input.providerId,
        email: line.address,
        remark: line.remark
      });
      if (result.created) {
        imported += 1;
        logEvent({ mailboxId: result.id, actorId: input.actorId, action: "import", detail: result.email });
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      errors.push(`${line.address}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, skipped, errors: errors.slice(0, 50) };
}

/** 普通用户自助导入：受配额限制，超出部分计入 quotaSkipped。 */
export function importMailboxesForUser(
  user: UserRow,
  input: { providerId: string; text: string }
): { imported: number; skipped: number; quotaSkipped: number; errors: string[] } {
  const option = getProviderOption(input.providerId);
  if (!option.supportsImport) {
    throw conflict(`${option.typeLabel} 不支持导入已有地址，请改用「生成新地址」`);
  }
  const { lines, errors, duplicates } = parseImportLines(input.text, 200);
  let imported = 0;
  let skipped = errors.length + duplicates;
  let quotaSkipped = 0;
  const kind = providerKindOfProviderId(input.providerId);
  let remaining = Math.max(0, getQuotas(user)[kind] - getQuotaUsage(user)[kind]);
  for (const line of lines) {
    try {
      assertImportAllowed(option, line.address);
    } catch (error) {
      skipped += 1;
      errors.push(`${line.address}：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const existing = getDb()
      .prepare("SELECT id, assigned_user_id, status FROM domain_mailboxes WHERE email = ?")
      .get(line.address) as { id: string; assigned_user_id: string | null; status: string } | undefined;
    if (existing?.assigned_user_id && existing.assigned_user_id !== user.id) {
      skipped += 1;
      errors.push(`${line.address}：该地址已被其他用户领取`);
      continue;
    }
    if (remaining <= 0) {
      quotaSkipped += 1;
      continue;
    }
    try {
      const result = upsertMailboxRow({
        providerId: input.providerId,
        email: line.address,
        remark: line.remark
      });
      if (result.created || !existing?.assigned_user_id) {
        attachMailboxToUser(result.id, user, "self-import");
        remaining -= 1;
        imported += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      errors.push(`${line.address}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, skipped, quotaSkipped, errors: errors.slice(0, 50) };
}

/** 普通用户自助生成：受配额限制，配额内能生成几个就生成几个。 */
export async function generateMailboxesForUser(
  user: UserRow,
  input: { providerId: string; prefix?: string; count: number }
): Promise<{ mailboxes: MailboxView[]; errors: string[] }> {
  const option = getProviderOption(input.providerId);
  if (!option.supportsGenerate) {
    throw conflict(`${option.typeLabel} 不支持生成新地址`);
  }
  const kind = providerKindOfProviderId(input.providerId);
  const quota = getQuotas(user)[kind];
  const remaining = Math.max(0, quota - getQuotaUsage(user)[kind]);
  if (remaining <= 0) {
    throw conflict(
      `已达到${kind === "domain" ? "域名邮箱" : "临时邮箱"}配额（${quota} 个），请先释放旧邮箱或联系管理员提高配额`
    );
  }
  const count = Math.min(Math.max(input.count, 1), 5, remaining);
  const result = await generateMailboxBatch({
    providerId: input.providerId,
    prefix: input.prefix,
    count
  });
  const created: MailboxView[] = [];
  for (const item of result.mailboxes) {
    const row = getMailboxRow(item.id);
    if (row.assigned_user_id && row.assigned_user_id !== user.id) {
      continue;
    }
    attachMailboxToUser(item.id, user, "self-generate");
    created.push(toView(getMailboxRow(item.id)));
  }
  return { mailboxes: created, errors: result.errors };
}

/** 标签数组的宽松解析：非法内容一律当空数组。 */
export function parseTagsJson(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function normalizeTagInput(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalid("tags 必须是字符串数组");
  }
  const cleaned = Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 24))
        .filter(Boolean)
    )
  );
  if (cleaned.length > 12) {
    throw invalid("一个邮箱最多 12 个标签");
  }
  return cleaned;
}

/** 设置邮箱标签：Outlook 账号写 accounts.tags_json，域名/临时写 domain_mailboxes.tags_json。 */
export function updateMailboxTags(mailboxId: string, tags: unknown): { tags: string[] } {
  const next = normalizeTagInput(tags);
  if (isOutlookAccountId(mailboxId)) {
    const row = getDb().prepare("SELECT id FROM accounts WHERE id = ?").get(mailboxId) as { id: string } | undefined;
    if (!row) {
      throw notFound("邮箱不存在");
    }
    getDb()
      .prepare("UPDATE accounts SET tags_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), nowIso(), mailboxId);
    return { tags: next };
  }
  const row = getMailboxRow(mailboxId);
  getDb()
    .prepare("UPDATE domain_mailboxes SET tags_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), nowIso(), row.id);
  return { tags: next };
}

/** 批量操作：delete / disable / enable / assign / unassign，同时支持 Outlook 与域名/临时邮箱。 */
export function applyBulkAction(input: {
  action: "delete" | "disable" | "enable" | "assign" | "unassign";
  ids: string[];
  userId: string | null;
  actorId: string;
}): { affected: number; skipped: number; errors: string[] } {
  const ids = Array.from(new Set(input.ids.filter(Boolean)));
  if (ids.length === 0) {
    throw invalid("请选择要操作的邮箱");
  }
  if (input.action === "delete") {
    return { affected: deleteMailboxes(ids, input.actorId), skipped: 0, errors: [] };
  }
  if ((input.action === "assign" || input.action === "unassign") && input.action === "assign" && !input.userId) {
    throw invalid("批量分配需要指定用户");
  }
  let affected = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      if (input.action === "disable" || input.action === "enable") {
        if (isOutlookAccountId(id)) {
          skipped += 1;
          errors.push(`${id}：Outlook 账号不支持停用/启用`);
          continue;
        }
        updateMailbox(id, { status: input.action === "disable" ? "disabled" : "assigned" }, input.actorId);
        affected += 1;
        continue;
      }
      assignMailbox(id, input.action === "assign" ? input.userId : null, input.actorId);
      affected += 1;
    } catch (error) {
      skipped += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { affected, skipped, errors: errors.slice(0, 50) };
}

/** 统一「获取邮箱」：按类型领取（Outlook）或生成（域名 / 临时）。 */
export async function acquireMailboxForUser(
  user: UserRow,
  input: { kind: MailboxKind; providerId?: string }
): Promise<{ mailbox: MailboxView; kind: MailboxKind }> {
  if (input.kind === "outlook") {
    const mailbox = claimOutlookAccount(user);
    logEvent({ mailboxId: mailbox.id, userId: user.id, actorId: user.id, action: "claim-outlook", detail: mailbox.email });
    return { mailbox: outlookToView(mailbox), kind: "outlook" };
  }

  const explicitProviderId = input.providerId?.trim() || "";
  let providerId = explicitProviderId;
  if (!providerId) {
    const candidates = listProviderOptions().filter(
      (item) => item.supportsGenerate && item.kind === input.kind
    );
    if (candidates.length === 0) {
      throw conflict(
        input.kind === "domain"
          ? "还没有可用的域名邮箱服务商，请联系管理员配置 IMAP 服务商"
          : "还没有可用的临时邮箱服务商，请联系管理员配置 GPTMail / mail.tm / YYDS"
      );
    }
    providerId = candidates[0].id;
  }
  const option = getProviderOption(providerId ?? "");
  const actualKind = option.kind === "domain" ? "domain" : "temp";
  if (actualKind !== input.kind) {
    throw invalid(`所选服务商属于${actualKind === "domain" ? "域名邮箱" : "临时邮箱"}，与请求类型不一致`);
  }
  if (!option.supportsGenerate) {
    throw conflict(`${option.typeLabel} 不支持生成地址`);
  }
  const quota = getQuotas(user)[actualKind];
  const used = getQuotaUsage(user)[actualKind];
  if (used >= quota) {
    throw conflict(
      `已达到${actualKind === "domain" ? "域名邮箱" : "临时邮箱"}配额（${quota} 个），请联系管理员提高配额`
    );
  }

  // 用户明确选了服务商 → 严格只用它：失败就把真实错误抛出来，绝不静默回退到别的服务商
  // （否则会出现「选了 YYDS，最后却拿到 GPTMail」的情况）。
  // 只有未指定服务商（系统自动挑选）时，才在同类型其他服务商之间回退兜底。
  const fallbackIds = explicitProviderId
    ? [providerId]
    : Array.from(
        new Set([
          providerId,
          ...listProviderOptions()
            .filter((item) => item.supportsGenerate && item.kind === actualKind)
            .map((item) => item.id)
        ])
      );
  const errors: string[] = [];
  for (const candidateId of fallbackIds) {
    const result = await generateMailboxBatch({ providerId: candidateId, count: 1 });
    if (result.mailboxes.length > 0) {
      const created = result.mailboxes[0];
      attachMailboxToUser(created.id, user, "self-generate");
      return { mailbox: toView(getMailboxRow(created.id)), kind: actualKind };
    }
    errors.push(...result.errors);
  }
  const first = errors[0] ?? "生成邮箱失败，请稍后重试";
  const quotaHint = /quota|limit|429/iu.test(errors.join(" "))
    ? "（公共 Key 当日额度可能已用尽：请在「服务商管理」里为 GPTMail 填自己的 API Key，或添加 mail.tm / YYDS 作为备用临时邮箱）"
    : "";
  if (explicitProviderId) {
    throw conflict(`「${option.typeLabel}」生成失败：${first}${quotaHint}`);
  }
  throw conflict(`${first}${quotaHint}`);
}

export interface StatsView {
  mailboxes: { outlook: number; domain: number; temp: number; total: number };
  messages: {
    total: number;
    today: number;
    last7d: number;
    byKind: { outlook: number; domain: number; temp: number };
  };
  daily: Array<{ date: string; count: number }>;
  topMailboxes: Array<{ email: string; kind: MailboxKind; count: number }>;
  claimsToday: number;
  providers: { total: number; enabled: number };
  users: { total: number; active: number };
}

/** 按天（本地日期）统计的键。 */
function dayKey(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

interface MessageStatRow {
  email: string;
  kind: MailboxKind;
  received: string | null;
}

function collectMessageStats(): MessageStatRow[] {
  const db = getDb();
  const rows: MessageStatRow[] = [];

  // 域名 / 临时邮箱：来自邮件缓存
  const domainRows = db
    .prepare(`
      SELECT m.email AS email, p.type AS provider_type, c.payload AS payload
      FROM mailbox_message_cache c
      JOIN domain_mailboxes m ON m.id = c.mailbox_id
      LEFT JOIN domain_providers p ON p.id = m.provider_id
    `)
    .all() as Array<{ email: string; provider_type: string | null; payload: string }>;
  for (const row of domainRows) {
    let received: string | null = null;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed && typeof parsed === "object") {
        received = (parsed as { receivedDateTime?: string | null }).receivedDateTime ?? null;
      }
    } catch {
      // 忽略坏缓存
    }
    rows.push({
      email: row.email,
      kind: row.provider_type === "imap" ? "domain" : "temp",
      received
    });
  }

  // Outlook：来自遗留邮件缓存
  const outlookRows = db
    .prepare(`
      SELECT a.email AS email, m.payload AS payload
      FROM mail_messages m
      JOIN accounts a ON a.id = m.account_id
    `)
    .all() as Array<{ email: string; payload: string }>;
  for (const row of outlookRows) {
    let received: string | null = null;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed && typeof parsed === "object") {
        received = (parsed as { receivedDateTime?: string | null }).receivedDateTime ?? null;
      }
    } catch {
      // 忽略坏缓存
    }
    rows.push({ email: row.email, kind: "outlook", received });
  }
  return rows;
}

export function getStats(): StatsView {
  const db = getDb();
  const outlookCounts = outlookPoolCounts();
  const kindTotals = db
    .prepare(`
      SELECT SUM(CASE WHEN p.type = 'imap' THEN 1 ELSE 0 END) AS domain_total,
             SUM(CASE WHEN p.type <> 'imap' THEN 1 ELSE 0 END) AS temp_total
      FROM domain_mailboxes m
      JOIN domain_providers p ON p.id = m.provider_id
    `)
    .get() as { domain_total: number | null; temp_total: number | null } | undefined;
  const domainTotal = Number(kindTotals?.domain_total ?? 0);
  const tempTotal = Number(kindTotals?.temp_total ?? 0);

  const messages = collectMessageStats();
  const todayKey = dayKey(new Date().toISOString());
  const daily: Array<{ date: string; count: number }> = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    daily.push({ date: dayKey(date.toISOString()), count: 0 });
  }
  const dailyIndex = new Map(daily.map((item, index) => [item.date, index]));

  const byKind: StatsView["messages"]["byKind"] = { outlook: 0, domain: 0, temp: 0 };
  const perMailbox = new Map<string, { email: string; kind: MailboxKind; count: number }>();
  let today = 0;
  let last7d = 0;
  for (const message of messages) {
    byKind[message.kind] += 1;
    const key = dayKey(message.received);
    if (key === todayKey) {
      today += 1;
    }
    const index = dailyIndex.get(key);
    if (index !== undefined) {
      daily[index].count += 1;
      last7d += 1;
    }
    const mailboxKey = `${message.kind}:${message.email}`;
    const entry = perMailbox.get(mailboxKey) ?? { email: message.email, kind: message.kind, count: 0 };
    entry.count += 1;
    perMailbox.set(mailboxKey, entry);
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const claims = db
    .prepare(
      "SELECT COUNT(*) AS total FROM mailbox_events WHERE action IN ('claim','claim-outlook','self-generate','self-import') AND created_at >= ?"
    )
    .get(startOfDay.toISOString()) as { total: number } | undefined;
  const providers = db
    .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM domain_providers")
    .get() as { total: number; enabled: number | null } | undefined;
  const users = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM users"
    )
    .get() as { total: number; active: number | null } | undefined;

  return {
    mailboxes: {
      outlook: outlookCounts.total,
      domain: domainTotal,
      temp: tempTotal,
      total: outlookCounts.total + domainTotal + tempTotal
    },
    messages: {
      total: messages.length,
      today,
      last7d,
      byKind
    },
    daily,
    topMailboxes: Array.from(perMailbox.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    claimsToday: Number(claims?.total ?? 0),
    providers: { total: Number(providers?.total ?? 0), enabled: Number(providers?.enabled ?? 0) },
    users: { total: Number(users?.total ?? 0), active: Number(users?.active ?? 0) }
  };
}

export function getOverview(): Overview {
  const db = getDb();
  const users = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
    FROM users
  `).get() as { total: number; admins: number | null; active: number | null } | undefined;

  const outlook = outlookPoolCounts();
  const kindTotals = db.prepare(`
    SELECT SUM(CASE WHEN p.type = 'imap' THEN 1 ELSE 0 END) AS domain_total,
           SUM(CASE WHEN p.type <> 'imap' THEN 1 ELSE 0 END) AS temp_total
    FROM domain_mailboxes m
    JOIN domain_providers p ON p.id = m.provider_id
  `).get() as { domain_total: number | null; temp_total: number | null } | undefined;

  const providers = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
    FROM domain_providers
  `).get() as { total: number; enabled: number | null } | undefined;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const claims = db
    .prepare(
      "SELECT COUNT(*) AS total FROM mailbox_events WHERE action IN ('claim','claim-outlook') AND created_at >= ?"
    )
    .get(startOfDay.toISOString()) as { total: number } | undefined;

  return {
    users: {
      total: Number(users?.total ?? 0),
      admins: Number(users?.admins ?? 0),
      active: Number(users?.active ?? 0)
    },
    // 池子只含 Outlook 账号；域名/临时邮箱数量另见 mailboxesByKind。
    mailboxes: outlook,
    mailboxesByKind: {
      outlook: outlook.total,
      domain: Number(kindTotals?.domain_total ?? 0),
      temp: Number(kindTotals?.temp_total ?? 0)
    },
    providers: {
      total: Number(providers?.total ?? 0),
      enabled: Number(providers?.enabled ?? 0)
    },
    claimsToday: Number(claims?.total ?? 0)
  };
}

async function withUpstreamErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(502, "UPSTREAM", error instanceof Error ? error.message : String(error), true);
  }
}

/** 管理端：确认 id 存在（Outlook 账号或域名邮箱都行）。 */
export function getAdminMailboxId(mailboxId: string): string {
  if (isOutlookAccountId(mailboxId)) {
    return mailboxId;
  }
  return getMailboxRow(mailboxId).id;
}

/** 用户侧：确认这个 id 属于自己，返回可用于取信的 id（Outlook 账号或域名邮箱都行）。 */
export function getOwnedMailboxId(userId: string, mailboxId: string): string {
  if (isOutlookAccountId(mailboxId)) {
    const row = getDb()
      .prepare("SELECT assigned_user_id FROM accounts WHERE id = ?")
      .get(mailboxId) as { assigned_user_id: string | null } | undefined;
    if (!row || row.assigned_user_id !== userId) {
      throw notFound("邮箱不存在");
    }
    return mailboxId;
  }
  return getOwnedMailboxRow(userId, mailboxId).id;
}

/** 邮件列表：上游成功即写缓存；上游失败回退到最近一次成功结果。 */
export async function mailboxMessages(mailboxId: string) {
  if (isOutlookAccountId(mailboxId)) {
    return withUpstreamErrors(async () => (await listAccountMessages({ accountId: mailboxId, top: 50 })).messages);
  }
  try {
    const messages = await listMailboxMessages(mailboxId);
    writeListCache(mailboxId, messages, new Date().toISOString());
    return messages;
  } catch (error) {
    const cached = readListCache(mailboxId);
    if (cached) {
      return cached.messages;
    }
    throw error instanceof HttpError ? error : new HttpError(502, "UPSTREAM", error instanceof Error ? error.message : String(error), true);
  }
}

/** 邮件详情：成功写缓存；失败回退缓存副本。 */
export async function mailboxMessageDetail(mailboxId: string, messageId: string) {
  if (isOutlookAccountId(mailboxId)) {
    return withUpstreamErrors(() => getAccountMessage({ accountId: mailboxId, messageId }));
  }
  try {
    const detail = await getMailboxMessage(mailboxId, messageId);
    writeDetailCache(mailboxId, messageId, detail);
    return detail;
  } catch (error) {
    const cached = readDetailCache(mailboxId, messageId);
    if (cached) {
      return cached.detail;
    }
    throw error instanceof HttpError ? error : new HttpError(502, "UPSTREAM", error instanceof Error ? error.message : String(error), true);
  }
}

export async function deleteMessage(mailboxId: string, messageId: string) {
  if (isOutlookAccountId(mailboxId)) {
    throw conflict("Outlook 邮箱暂不支持在网页端删除邮件");
  }
  await withUpstreamErrors(() => deleteMailboxMessage(mailboxId, messageId));
  dropMessageFromCache(mailboxId, messageId);
  return { deleted: true };
}

export async function clearInbox(mailboxId: string) {
  if (isOutlookAccountId(mailboxId)) {
    throw conflict("Outlook 邮箱暂不支持在网页端清空收件箱");
  }
  await withUpstreamErrors(() => clearMailbox(mailboxId));
  dropListCache(mailboxId);
  return { cleared: true };
}
