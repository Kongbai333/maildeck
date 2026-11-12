import type { MailMessageSummary } from "../../electron/shared/ipc-contracts.js";
import { getDb } from "./db.js";
import type { DomainMessageDetail } from "./domain-adapters.js";

/** 邮件缓存：上游读取成功后写库；上游失败时回退到最近一次成功结果。 */

export function readListCache(mailboxId: string): { messages: MailMessageSummary[]; updatedAt: string } | null {
  const row = getDb()
    .prepare("SELECT payload, updated_at FROM mailbox_list_cache WHERE mailbox_id = ?")
    .get(mailboxId) as { payload: string; updated_at: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return Array.isArray(parsed) ? { messages: parsed as MailMessageSummary[], updatedAt: row.updated_at } : null;
  } catch {
    return null;
  }
}

export function writeListCache(mailboxId: string, messages: MailMessageSummary[], updatedAt: string): void {
  getDb()
    .prepare(`
      INSERT INTO mailbox_list_cache (mailbox_id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(mailbox_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `)
    .run(mailboxId, JSON.stringify(messages), updatedAt);
  const statement = getDb().prepare(`
    INSERT INTO mailbox_message_cache (mailbox_id, message_id, payload, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(mailbox_id, message_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  for (const message of messages) {
    if (message.id) {
      statement.run(mailboxId, message.id, JSON.stringify(message), updatedAt);
    }
  }
}

export function readMessageCache(mailboxId: string, messageId: string): MailMessageSummary | null {
  const row = getDb()
    .prepare("SELECT payload FROM mailbox_message_cache WHERE mailbox_id = ? AND message_id = ?")
    .get(mailboxId, messageId) as { payload: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === "object" ? (parsed as MailMessageSummary) : null;
  } catch {
    return null;
  }
}

export function readDetailCache(
  mailboxId: string,
  messageId: string
): { detail: DomainMessageDetail; updatedAt: string } | null {
  const row = getDb()
    .prepare("SELECT payload, updated_at FROM mailbox_detail_cache WHERE mailbox_id = ? AND message_id = ?")
    .get(mailboxId, messageId) as { payload: string; updated_at: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === "object"
      ? { detail: parsed as DomainMessageDetail, updatedAt: row.updated_at }
      : null;
  } catch {
    return null;
  }
}

export function writeDetailCache(mailboxId: string, messageId: string, detail: DomainMessageDetail): string {
  const timestamp = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO mailbox_detail_cache (mailbox_id, message_id, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(mailbox_id, message_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `)
    .run(mailboxId, messageId, JSON.stringify(detail), timestamp);
  return timestamp;
}

export function dropMessageFromCache(mailboxId: string, messageId: string): void {
  getDb().prepare("DELETE FROM mailbox_message_cache WHERE mailbox_id = ? AND message_id = ?").run(mailboxId, messageId);
  getDb().prepare("DELETE FROM mailbox_detail_cache WHERE mailbox_id = ? AND message_id = ?").run(mailboxId, messageId);
}

export function dropListCache(mailboxId: string): void {
  getDb().prepare("DELETE FROM mailbox_list_cache WHERE mailbox_id = ?").run(mailboxId);
}
