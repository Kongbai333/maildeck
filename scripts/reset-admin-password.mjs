import { closeDb, getDb } from "../server/src/db.js";
import { hashPassword } from "../server/src/password.js";

const username = process.argv[2] ?? "admin";
const password = process.argv[3] ?? "MailDeck@2026";
const db = getDb();
const now = new Date().toISOString();
const hash = hashPassword(password);
const updated = db
  .prepare("UPDATE users SET password_hash = ?, status = 'active', role = 'admin', updated_at = ? WHERE username = ?")
  .run(hash, now, username);
if (Number(updated.changes) === 0) {
  db.prepare(`
    INSERT INTO users
      (id, username, password_hash, role, status, mailbox_quota, quota_outlook, quota_domain, quota_temp, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 'active', 10, 10, 10, 10, ?, ?)
  `).run("admin-local", username, hash, now, now);
}
db.prepare("DELETE FROM sessions").run();
const rows = db.prepare("SELECT username, role, status FROM users").all();
console.log(JSON.stringify(rows));
closeDb();
