import type { MailCacheStats, MailMessageDetail, MailMessageSummary } from "../../shared/mail-contracts.js";
import { getDb, transaction } from "./db.js";

const CACHE_TTL_MS = 5 * 60 * 1_000;

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function saveMessages(
  accountId: string,
  folderId: string,
  messages: MailMessageSummary[],
  nextCursor: string | null
) {
  transaction(() => {
    const db = getDb();
    const timestamp = nowIso();
    const statement = db.prepare(`
      INSERT INTO mail_messages (account_id, folder_id, message_id, payload, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder_id, message_id)
      DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `);
    for (const message of messages) {
      statement.run(accountId, folderId, message.id, JSON.stringify(message), timestamp);
    }
    db.prepare(`
      INSERT INTO mail_meta (account_id, folder_id, next_cursor, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, folder_id)
      DO UPDATE SET next_cursor = excluded.next_cursor, updated_at = excluded.updated_at
    `).run(accountId, folderId, nextCursor, timestamp);
  });
}

export function getCachedMessages(
  accountId: string,
  folderId: string,
  search = "",
  top = 50
): MailMessageSummary[] | null {
  const rows = getDb()
    .prepare(`
      SELECT payload, updated_at FROM mail_messages
      WHERE account_id = ? AND folder_id = ?
      ORDER BY updated_at DESC
    `)
    .all(accountId, folderId) as Array<{ payload: string; updated_at: string }>;
  if (rows.length === 0) {
    return null;
  }
  const newest = Date.parse(rows[0].updated_at);
  if (!Number.isFinite(newest) || Date.now() - newest > CACHE_TTL_MS) {
    return null;
  }

  const query = search.trim().toLowerCase();
  return rows
    .map((row) => parseJson<MailMessageSummary>(row.payload))
    .filter((message): message is MailMessageSummary => Boolean(message))
    .filter((message) => !query || message.subject.toLowerCase().includes(query))
    .sort((left, right) => {
      const leftTime = left.receivedDateTime ? Date.parse(left.receivedDateTime) : 0;
      const rightTime = right.receivedDateTime ? Date.parse(right.receivedDateTime) : 0;
      return rightTime - leftTime;
    })
    .slice(0, Math.max(1, Math.min(top, 100)));
}

export function getCachedDetail(
  accountId: string,
  folderId: string,
  messageId: string
): MailMessageDetail | null {
  const row = getDb()
    .prepare(`
      SELECT payload, updated_at FROM mail_details
      WHERE account_id = ? AND folder_id = ? AND message_id = ?
    `)
    .get(accountId, folderId, messageId) as { payload: string; updated_at: string } | undefined;
  if (!row) {
    return null;
  }
  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > CACHE_TTL_MS) {
    return null;
  }
  return parseJson<MailMessageDetail>(row.payload);
}

export function saveDetail(accountId: string, folderId: string, detail: MailMessageDetail) {
  getDb()
    .prepare(`
      INSERT INTO mail_details (account_id, folder_id, message_id, payload, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder_id, message_id)
      DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `)
    .run(accountId, folderId, detail.id, JSON.stringify(detail), nowIso());
}

export function getCacheStats(): MailCacheStats {
  const messageRow = getDb()
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM mail_messages")
    .get() as { count: number; bytes: number };
  const detailRow = getDb()
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM mail_details")
    .get() as { count: number; bytes: number };
  const accountRow = getDb()
    .prepare("SELECT COUNT(DISTINCT account_id) AS count FROM mail_messages")
    .get() as { count: number };

  return {
    accountCount: accountRow.count,
    messageCount: messageRow.count,
    bodyCount: detailRow.count,
    approximateBytes: messageRow.bytes + detailRow.bytes
  };
}

export function clearCache(accountId?: string) {
  if (accountId) {
    getDb().prepare("DELETE FROM mail_messages WHERE account_id = ?").run(accountId);
    getDb().prepare("DELETE FROM mail_details WHERE account_id = ?").run(accountId);
    getDb().prepare("DELETE FROM mail_meta WHERE account_id = ?").run(accountId);
    return;
  }

  getDb().exec("DELETE FROM mail_messages; DELETE FROM mail_details; DELETE FROM mail_meta;");
}
