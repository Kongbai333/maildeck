-- MailDeck 域名邮箱 · Cloudflare D1 收信存储
-- 用法：wrangler d1 execute maildeck_mail --file=./schema.sql --remote
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  body TEXT,
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mails_to_id ON mails (to_addr, id DESC);
CREATE INDEX IF NOT EXISTS idx_mails_ts ON mails (ts);
