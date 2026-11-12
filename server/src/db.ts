import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePath, serverConfig } from "./config.js";

export interface UserRowShape {
  id: string;
  username: string;
  password_hash: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  mailbox_quota: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AccountRow {
  id: string;
  email: string;
  client_id: string;
  encrypted_refresh_token: string;
  remark: string;
  group_name: string;
  tags_json: string;
  status: "untested" | "valid" | "invalid";
  last_checked_at: string | null;
  last_error: string | null;
  last_refreshed_at: string | null;
  last_inbox_count: number;
  last_mail_at: string | null;
  last_mail_cursor: string | null;
  inbox_folder_id: string | null;
  graph_delta_link: string | null;
  auth_mode: "graph" | "imap" | null;
  created_at: string;
  updated_at: string;
}

let database: DatabaseSync | null = null;

function createSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS account_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'all',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_groups_name ON account_groups(name);

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'untested',
      last_checked_at TEXT,
      last_error TEXT,
      last_refreshed_at TEXT,
      last_inbox_count INTEGER NOT NULL DEFAULT 0,
      last_mail_at TEXT,
      last_mail_cursor TEXT,
      inbox_folder_id TEXT,
      graph_delta_link TEXT,
      auth_mode TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

    CREATE TABLE IF NOT EXISTS mail_messages (
      account_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, folder_id, message_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mail_messages_account_folder
      ON mail_messages(account_id, folder_id, updated_at);

    CREATE TABLE IF NOT EXISTS mail_details (
      account_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, folder_id, message_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mail_meta (
      account_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      next_cursor TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, folder_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domain_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      key_mode TEXT NOT NULL DEFAULT 'public',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domain_mailboxes (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      email TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      remark TEXT NOT NULL DEFAULT '',
      secret_encrypted TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES domain_providers(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_mailboxes_email ON domain_mailboxes(email);
    CREATE INDEX IF NOT EXISTS idx_domain_mailboxes_provider ON domain_mailboxes(provider_id);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      mailbox_quota INTEGER NOT NULL DEFAULT 1,
      can_online_play INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS mailbox_events (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT,
      user_id TEXT,
      actor_id TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    -- 邮件缓存：列表 + 详情，上游不可用时回退到最近一次成功结果。
    CREATE TABLE IF NOT EXISTS mailbox_message_cache (
      mailbox_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS mailbox_detail_cache (
      mailbox_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS mailbox_list_cache (
      mailbox_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mailbox_events_created ON mailbox_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_mailbox_events_mailbox ON mailbox_events(mailbox_id);
  `);
}

/** 邮箱池字段：老库没有归属/状态列，按「可用」补齐，历史生成的邮箱自动进入池子。 */
function migrateMailboxPoolColumns(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(domain_mailboxes)").all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("assigned_user_id")) {
    db.exec("ALTER TABLE domain_mailboxes ADD COLUMN assigned_user_id TEXT");
  }
  if (!has("status")) {
    db.exec("ALTER TABLE domain_mailboxes ADD COLUMN status TEXT NOT NULL DEFAULT 'available'");
  }
  if (!has("assigned_at")) {
    db.exec("ALTER TABLE domain_mailboxes ADD COLUMN assigned_at TEXT");
  }
  if (!has("secret_encrypted")) {
    db.exec("ALTER TABLE domain_mailboxes ADD COLUMN secret_encrypted TEXT NOT NULL DEFAULT ''");
  }
  if (!has("tags_json")) {
    db.exec("ALTER TABLE domain_mailboxes ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_domain_mailboxes_pool ON domain_mailboxes(status, assigned_user_id, created_at)"
  );
}

export function getDb(): DatabaseSync {
  if (database) {
    return database;
  }

  mkdirSync(serverConfig.dataDir, { recursive: true });
  database = new DatabaseSync(databasePath());
  createSchema(database);
  migrateMailboxPoolColumns(database);
  const accountColumns = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === "tags_json")) {
    database.exec("ALTER TABLE accounts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  const groupColumns = database.prepare("PRAGMA table_info(account_groups)").all() as Array<{ name: string }>;
  if (!groupColumns.some((column) => column.name === "category")) {
    database.exec("ALTER TABLE account_groups ADD COLUMN category TEXT NOT NULL DEFAULT 'all'");
  }
  // 老库没有 key_mode：默认公共 Key，启动刷新才会覆盖到这些服务商。
  const providerColumns = database.prepare("PRAGMA table_info(domain_providers)").all() as Array<{ name: string }>;
  if (!providerColumns.some((column) => column.name === "key_mode")) {
    database.exec("ALTER TABLE domain_providers ADD COLUMN key_mode TEXT NOT NULL DEFAULT 'public'");
  }
  if (!providerColumns.some((column) => column.name === "meta_json")) {
    database.exec("ALTER TABLE domain_providers ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'");
  }
  // 三类配额（Outlook / 域名邮箱 / 临时邮箱）：老库只有 mailbox_quota，按它兜底。
  const userColumns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  for (const column of ["quota_outlook", "quota_domain", "quota_temp", "used_outlook", "used_domain", "used_temp"]) {
    if (!userColumns.some((item) => item.name === column)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER`);
    }
  }
  // 在线播放权限：管理员按账号开启（默认关闭）。
  if (!userColumns.some((item) => item.name === "can_online_play")) {
    database.exec("ALTER TABLE users ADD COLUMN can_online_play INTEGER NOT NULL DEFAULT 0");
  }
  // Outlook 账号池：微软账号也要能分配给用户。
  const accountColumnsForPool = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  if (!accountColumnsForPool.some((column) => column.name === "assigned_user_id")) {
    database.exec("ALTER TABLE accounts ADD COLUMN assigned_user_id TEXT");
  }
  if (!accountColumnsForPool.some((column) => column.name === "assigned_at")) {
    database.exec("ALTER TABLE accounts ADD COLUMN assigned_at TEXT");
  }
  // 归属来源：pool=从邮箱池领取，admin=管理员分配，import=用户自助导入（不占配额）。
  if (!accountColumnsForPool.some((column) => column.name === "assigned_via")) {
    database.exec("ALTER TABLE accounts ADD COLUMN assigned_via TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_accounts_pool ON accounts(assigned_user_id, status)");
  return database;
}

export function closeDb() {
  database?.close();
  database = null;
}

export function transaction<T>(operation: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled the transaction back on I/O errors.
    }
    throw error;
  }
}
