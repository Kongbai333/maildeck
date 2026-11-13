import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MailMessageDetail, MailMessageSummary } from "../shared/mail-contracts.js";
import { RequestValidationError } from "../shared/mail-contracts.js";
import { toPublicErrorPayload } from "../server/mail/error-utils.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-web-core-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
let database: typeof import("../server/src/db.js");
let cache: typeof import("../server/src/cache-service.js");
let settings: typeof import("../server/src/settings-service.js");

beforeAll(async () => {
  database = await import("../server/src/db.js");
  cache = await import("../server/src/cache-service.js");
  settings = await import("../server/src/settings-service.js");
  const stamp = new Date().toISOString();
  const insert = database.getDb().prepare("INSERT INTO accounts (id, email, client_id, encrypted_refresh_token, created_at, updated_at) VALUES (?, ?, 'fixture-client', 'fixture-token', ?, ?)");
  for (const id of ["account-a", "account-b"]) insert.run(id, `${id}@example.invalid`, stamp, stamp);
});
beforeEach(() => { cache.clearCache(); database.getDb().exec("DELETE FROM settings"); });
afterAll(() => { database.closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

function summary(subject: string): MailMessageSummary {
  return { id: "same-id", subject, from: null, receivedDateTime: new Date().toISOString(), sentDateTime: null, isRead: false, importance: "normal", hasAttachments: false, bodyPreview: subject, webLink: null };
}

describe("web server mail core", () => {
  it("isolates cached messages by both account and folder", () => {
    cache.saveMessages("account-a", "inbox", [summary("A inbox")], null);
    cache.saveMessages("account-a", "archive", [summary("A archive")], null);
    cache.saveMessages("account-b", "inbox", [summary("B inbox")], null);
    expect(cache.getCachedMessages("account-a", "inbox")?.map((mail) => mail.subject)).toEqual(["A inbox"]);
    expect(cache.getCachedMessages("account-a", "archive")?.map((mail) => mail.subject)).toEqual(["A archive"]);
    expect(cache.getCachedMessages("account-b", "inbox")?.map((mail) => mail.subject)).toEqual(["B inbox"]);
  });

  it("persists message content and type across database reopen", () => {
    const detail: MailMessageDetail = { ...summary("plain text"), toRecipients: [], ccRecipients: [], body: { contentType: "text", content: "<b>This is literal text</b>" } };
    cache.saveDetail("account-a", "inbox", detail);
    database.closeDb();
    expect(cache.getCachedDetail("account-a", "inbox", detail.id)).toEqual(detail);
    expect(cache.getCachedDetail("account-b", "inbox", detail.id)).toBeNull();
  });

  it("clears one account without deleting another account's cached mail", () => {
    cache.saveMessages("account-a", "inbox", [summary("A")], null);
    cache.saveMessages("account-b", "inbox", [summary("B")], null);
    cache.clearCache("account-a");
    expect(cache.getCachedMessages("account-a", "inbox")).toBeNull();
    expect(cache.getCachedMessages("account-b", "inbox")?.[0].subject).toBe("B");
  });

  it("drops retired desktop settings while preserving web mail settings", () => {
    const stored = { cacheMessages: false, cacheBodies: true, batchConcurrency: 8, proxyUrl: "http://127.0.0.1:9000", autoUpdateCheckEnabled: true, closeToTray: true, launchAtStartup: true };
    database.getDb().prepare("INSERT INTO settings (id, payload, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(stored), new Date().toISOString());
    expect(settings.getSettings()).toMatchObject({ cacheMessages: false, batchConcurrency: 8, proxyUrl: stored.proxyUrl });
    const updated = settings.updateSettings({ cacheBodies: false });
    expect(updated).toMatchObject({ cacheMessages: false, cacheBodies: false, batchConcurrency: 8 });
    const row = database.getDb().prepare("SELECT payload FROM settings WHERE id = 1").get() as { payload: string };
    for (const field of ["autoUpdateCheckEnabled", "closeToTray", "launchAtStartup"]) {
      expect(updated).not.toHaveProperty(field);
      expect(JSON.parse(row.payload)).not.toHaveProperty(field);
    }
  });

  it("preserves validation error classification without a desktop bridge", () => {
    expect(toPublicErrorPayload(new RequestValidationError("invalid mailbox input"))).toMatchObject({ code: "INVALID_REQUEST", message: "invalid mailbox input", retryable: false });
  });
});
