import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

export interface AccountGroupView {
  id: string;
  name: string;
  category: string;
  accountCount: number;
}

function nowIso() {
  return new Date().toISOString();
}

export function listGroups(): AccountGroupView[] {
  const rows = getDb()
    .prepare(`
      SELECT g.id, g.name, g.category, COUNT(a.id) AS account_count
      FROM account_groups g
      LEFT JOIN accounts a ON a.group_name = g.name
      GROUP BY g.id, g.name, g.category
      ORDER BY g.created_at ASC, g.name ASC
    `)
    .all() as unknown as Array<{ id: string; name: string; category: string; account_count: number }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    accountCount: row.account_count
  }));
}

export function createGroup(name: string, category = "all"): AccountGroupView[] {
  const groupName = name.trim();
  if (!groupName || groupName.length > 100) {
    throw new Error("分组名称长度必须在 1 到 100 个字符之间");
  }
  const existing = getDb()
    .prepare("SELECT id FROM account_groups WHERE lower(name) = lower(?)")
    .get(groupName) as { id: string } | undefined;
  if (existing) {
    throw new Error("分组名称已存在");
  }

  const timestamp = nowIso();
  getDb()
    .prepare("INSERT INTO account_groups (id, name, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), groupName, category, timestamp, timestamp);
  return listGroups();
}

export function deleteGroup(groupId: string): AccountGroupView[] {
  const group = getDb()
    .prepare("SELECT id, name FROM account_groups WHERE id = ?")
    .get(groupId) as { id: string; name: string } | undefined;
  if (!group) {
    throw new Error("分组不存在");
  }
  getDb().prepare("UPDATE accounts SET group_name = '' WHERE group_name = ?").run(group.name);
  getDb().prepare("DELETE FROM account_groups WHERE id = ?").run(groupId);
  return listGroups();
}
